'use strict';
// app/mcpgate.js — the impure seam of the MCP tool-poisoning gate. connectors.js holds the PURE verdict logic
// (scanTools / pinManifest / manifestDrift, all reusing skillhub.scan); this module does the two things that touch
// the world:
//   1. a MINIMAL MCP stdio client that fetches a server's advertised tool manifest — the runtime-mutable
//      names + descriptions + input schemas that connectors.js's command scan never saw. This is the
//      tool-poisoning / rug-pull vector (an independent scan found poisoned tool descriptions on ~5.5% of ~1,900
//      public MCP servers); the OWASP "MCP / LLM Top-10" and Snyk's agent-scan pattern both name it.
//   2. persistence of the sha256 manifest PIN alongside the connector config (VAULT/_urfael/connectors/<id>.json),
//      so a LATER connect can detect a rug-pull — a description/schema swapped after the owner approved it.
//
// Fail-closed and honest, and it NEVER throws into a shared path: a poisoned manifest is REFUSED at add-time, a
// DRIFTED manifest is REFUSED until re-approved, and a listing that genuinely can't happen (offline / no npx / a
// remote transport) is surfaced as "not scanned" rather than a silent pass. Zero third-party deps — child_process
// + fs + the pure helpers in connectors.js only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const con = require('./connectors');
const auditChain = require('./audit-chain');

const VAULT = path.join(os.homedir(), process.env.URFAEL_VAULT_DIR || 'Urfael');
// one <id>.json pin per approved connector, sibling of _urfael/skills and _urfael/plugins.
function pinsDir() { return path.join(VAULT, '_urfael', 'connectors'); }
function pinPath(id) { return path.join(pinsDir(), con.slugify(id) + '.json'); }

function readPin(id) { try { return JSON.parse(fs.readFileSync(pinPath(id), 'utf8')); } catch { return null; } }
function writePin(id, record) {
  try { fs.mkdirSync(pinsDir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(pinPath(id), JSON.stringify(record, null, 2), { mode: 0o600 }); return true; }
  catch { return false; }
}
function removePin(id) { try { fs.unlinkSync(pinPath(id)); return true; } catch { return false; } }

// The stdio argv for a connector, mirroring buildAddArgs' `-- <runner> <pkg>` tail. Only stdio transports
// (npx/uvx) can be listed this way; http/sse speak MCP over the network and are not fetched here (surfaced
// honestly to the owner). Returns null for a non-stdio / malformed entry.
function stdioCmd(entry) {
  if (!entry) return null;
  if (entry.transport === 'npx' && entry.pkg) return { cmd: 'npx', args: ['-y', entry.pkg] };
  if (entry.transport === 'uvx' && entry.pkg) return { cmd: 'uvx', args: [entry.pkg] };
  return null;
}

// Minimal MCP stdio client: spawn the server, run the JSON-RPC handshake (initialize → notifications/initialized →
// tools/list) over newline-delimited JSON (the MCP stdio framing), resolve the advertised tools, then kill it.
// FAIL-CLOSED + bounded: a hard timeout, an output cap, and it NEVER rejects — every failure resolves
// { ok:false, listed:false, error } so a listing problem can't throw into the add path. opts.spawn is injectable
// so tests can drive a real fake server without any network.
function listStdioTools(entry, opts = {}) {
  return new Promise((resolve) => {
    const sc = stdioCmd(entry);
    if (!sc) return resolve({ ok: false, listed: false, error: 'not a stdio connector (only npx/uvx tool lists can be fetched here)' });
    const spawnFn = opts.spawn || spawn;
    const timeoutMs = opts.timeoutMs || 20000;
    const secrets = opts.secrets || {};
    const env = { ...process.env };                                         // secrets go in env, never on the argv (same as buildAddArgs' --env)
    for (const f of con.secretsNeeded(entry)) if (secrets[f.key]) env[f.key] = secrets[f.key];

    let child;
    try { child = spawnFn(sc.cmd, sc.args, { stdio: ['pipe', 'pipe', 'ignore'], env }); }
    catch (e) { return resolve({ ok: false, listed: false, error: 'spawn failed: ' + ((e && e.message) || e) }); }

    let done = false, buf = '', out = 0;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, listed: false, error: 'timeout fetching tool manifest (' + timeoutMs + 'ms)' }), timeoutMs);
    if (timer.unref) timer.unref();
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };

    child.on('error', (e) => finish({ ok: false, listed: false, error: 'server error: ' + ((e && e.message) || e) }));
    child.on('exit', () => finish({ ok: false, listed: false, error: 'server exited before advertising its tools' }));
    child.stdout.on('data', (d) => {
      out += d.length; if (out > 512 * 1024) return finish({ ok: false, listed: false, error: 'tool manifest too large (> 512KB)' });
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {                               // newline-delimited JSON-RPC (MCP stdio framing)
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }        // ignore any non-JSON banner line
        if (msg.id === 1 && msg.result) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        else if (msg.id === 2) finish({ ok: true, listed: true, tools: (msg.result && Array.isArray(msg.result.tools)) ? msg.result.tools : [] });
      }
    });
    // kick off the handshake
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'urfael-connector-gate', version: '1' } } });
  });
}

// A ledger-ready refusal record. audit-chain owns the tamper-evident chain (the daemon appends to it); `urfael
// connect` runs OFFLINE, before the daemon, so we do NOT write the chain here (that would break its seq/prevH) —
// we build the canonical, digestible record so a caller WITH the chain could witness it, and surface it loudly.
function refusalRecord(entry, kind, detail) {
  const d = detail || {};
  const payload = { ev: 'connector.refused', id: entry && entry.id, kind, at: new Date().toISOString(),
    detail: kind === 'poisoned'
      ? { poisonedTools: d.poisonedTools || [], dangers: d.dangers || 0 }
      : { changed: d.changed || [], added: d.added || [], removed: d.removed || [] } };
  return { payload, payloadDigest: auditChain.digest(auditChain.canonicalJSON(payload)) };
}

// gateAdd — the enable-time gate. Fetch the server's advertised tools, scan them for poisoning, and (on a clean
// manifest) compute the pin. FAIL-CLOSED verdict: poisoned ⇒ { ok:false, reason:'poisoned' }. If the tools
// genuinely can't be fetched we DON'T silently pass and DON'T hard-block the add — { ok:true, listed:false } lets
// cli.js tell the owner scanning was skipped (the command scan still applied). Persist the pin only AFTER the
// owner confirms, via approve().
async function gateAdd(entry, opts = {}) {
  const r = await listStdioTools(entry, opts);
  if (!r.ok) return { ok: true, listed: false, gated: false, reason: r.error };
  const scan = con.scanTools(r.tools);
  if (scan.poisoned) return { ok: false, listed: true, gated: true, reason: 'poisoned', scan, tools: r.tools, refusal: refusalRecord(entry, 'poisoned', scan) };
  return { ok: true, listed: true, gated: true, reason: 'clean', scan, tools: r.tools, pin: con.pinManifest(r.tools) };
}

// persist the approved pin (call ONLY after the owner confirms a clean manifest).
function approve(entry, pin) {
  return writePin(entry && entry.id, { id: entry && entry.id, name: entry && entry.name, pinnedAt: new Date().toISOString(), ...(pin || {}) });
}

// gateVerify — a LATER connect: re-fetch, re-scan, and compare against the stored pin. FAIL-CLOSED: a drifted
// manifest (rug-pull) ⇒ { ok:false, reason:'drift', drift } until the owner re-approves; a manifest that became
// poisoned ⇒ { ok:false, reason:'poisoned' }; a pinned server we can't re-check ⇒ { ok:false, reason:'unverifiable' }
// (we don't hand out a clean bill we couldn't earn). No pin yet ⇒ { ok:false, reason:'unpinned' }.
async function gateVerify(entry, opts = {}) {
  const pinned = readPin(entry && entry.id);
  if (!pinned) return { ok: false, reason: 'unpinned', note: 'this connector was never approved through the tool-poisoning gate' };
  const r = await listStdioTools(entry, opts);
  if (!r.ok) return { ok: false, listed: false, reason: 'unverifiable', note: r.error, pinned };
  const scan = con.scanTools(r.tools);
  if (scan.poisoned) return { ok: false, listed: true, reason: 'poisoned', scan, tools: r.tools, refusal: refusalRecord(entry, 'poisoned', scan) };
  const drift = con.manifestDrift(r.tools, pinned);
  if (drift.drifted) return { ok: false, listed: true, reason: 'drift', drift, tools: r.tools, refusal: refusalRecord(entry, 'drift', drift) };
  return { ok: true, listed: true, reason: 'unchanged', drift, tools: r.tools };
}

// reapprove — after the owner has SEEN a drift diff and accepts it, re-fetch + re-scan and re-pin the current
// manifest. Refuses to re-pin a poisoned manifest (a rug-pull that introduced an injection still fails closed).
async function reapprove(entry, opts = {}) {
  const r = await listStdioTools(entry, opts);
  if (!r.ok) return { ok: false, reason: 'unverifiable', note: r.error };
  const scan = con.scanTools(r.tools);
  if (scan.poisoned) return { ok: false, reason: 'poisoned', scan, tools: r.tools, refusal: refusalRecord(entry, 'poisoned', scan) };
  const pin = con.pinManifest(r.tools);
  return { ok: approve(entry, pin), reason: 'reapproved', pin, tools: r.tools };
}

module.exports = {
  pinsDir, pinPath, readPin, writePin, removePin, stdioCmd, listStdioTools,
  gateAdd, gateVerify, reapprove, approve, refusalRecord,
};
