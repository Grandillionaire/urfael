'use strict';
// app/connectors.js — optional MCP connectors, set up the Urfael way: previewed, scanned, secrets masked,
// owner-turns only. A "connector" is just an MCP server — the open standard the `claude` brain already speaks
// (`claude mcp add`). The full ecosystem is tens of thousands of servers; this module curates the popular ones
// and wraps `add` in the same paranoia we give skills: show exactly what it can do, statically scan the resolved
// command, prompt for secrets WITHOUT echoing them or leaking them to shell history, and confirm before anything
// is written. Sandboxed turns never load connectors — every remote/cron/job spawn already runs --strict-mcp-config
// (see daemon.js), so a connector is a power that exists only on trusted owner turns.
//
// This file is PURE: it parses the registry, searches it, builds the `claude mcp add` ARGV (an array — so the
// daemon/cli can execFile it, never a shell string, so a secret can't land in ~/.zsh_history or `ps`), and
// produces the security preview. The actual spawn + the masked prompt live in cli.js. Everything here is unit-tested.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const skillhub = require('./skillhub');       // REUSE its static safety scanner over tool descriptions — never reimplemented
const auditChain = require('./audit-chain');  // canonicalJSON for a deterministic manifest pin (one source of truth)

const TRANSPORTS = new Set(['npx', 'uvx', 'http', 'sse']);
const AUTHS = new Set(['none', 'key', 'oauth', 'local']);

// The bundled registry ships in the repo; URFAEL_CONNECTORS_INDEX can point at your own JSON (same schema).
function registryPath() {
  return process.env.URFAEL_CONNECTORS_INDEX || path.join(__dirname, '..', 'config', 'connectors.json');
}

// kebab id: lowercase, [a-z0-9-] only. The only thing we ever pass to `claude mcp add` as the server name.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// Parse + validate a registry. Pure, fail-soft: returns [] on junk and DROPS any entry that isn't shaped right
// (bad id, unknown transport/auth, npx/uvx without a sane pkg, http/sse without an https-or-localhost url). A
// malformed or hostile registry can therefore only ever yield fewer connectors, never a malformed command.
function parse(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(j) ? j : (j && Array.isArray(j.connectors) ? j.connectors : []);
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = slugify(e.id || e.name || '');
    if (!id || !/^[a-z0-9-]+$/.test(id)) continue;
    const transport = String(e.transport || '').toLowerCase();
    if (!TRANSPORTS.has(transport)) continue;
    const auth = AUTHS.has(String(e.auth || '').toLowerCase()) ? String(e.auth).toLowerCase() : 'none';
    const c = {
      id,
      name: String(e.name || id).slice(0, 60),
      category: String(e.category || 'misc').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'misc',
      transport, auth,
      note: String(e.note || '').replace(/\s+/g, ' ').slice(0, 200),
      verified: e.verified === true,
      env: [],
    };
    if (transport === 'npx' || transport === 'uvx') {
      // a package token only: no shell metacharacters, no whitespace, no url — it goes after `npx -y`/`uvx`.
      const pkg = String(e.pkg || '');
      if (!pkg || !/^[@a-zA-Z0-9][\w.@/\-]*$/.test(pkg)) continue;
      c.pkg = pkg;
    } else {
      // http/sse: must be a real https URL, or an explicit loopback (a local service the user runs themselves).
      let u; try { u = new URL(String(e.url || '')); } catch { continue; }
      if (u.protocol !== 'https:' && !isLoopback(u.hostname)) continue;
      c.url = u.toString();
    }
    if (auth === 'key' && Array.isArray(e.env)) {
      for (const f of e.env) {
        const key = String((f && f.key) || '').trim();
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;           // env var names only — can't smuggle a flag
        c.env.push({ key, label: String((f && f.label) || key).slice(0, 80) });
      }
    }
    out.push(c);
  }
  return out;
}

function load(file) {
  let text = ''; try { text = fs.readFileSync(file || registryPath(), 'utf8'); } catch { return []; }
  return parse(text);
}

function isLoopback(h) {
  const s = String(h || '').toLowerCase();
  return s === 'localhost' || s === '127.0.0.1' || s === '::1' || s === '0.0.0.0';
}

function search(list, q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return list;
  return list.filter((c) => (c.id + ' ' + c.name + ' ' + c.category + ' ' + c.note).toLowerCase().includes(s));
}
function find(list, id) { const k = slugify(id); return (list || []).find((c) => c.id === k) || null; }

function categories(list) {
  const m = new Map();
  for (const c of list) { if (!m.has(c.category)) m.set(c.category, []); m.get(c.category).push(c); }
  return m;
}

// Which secret fields the user must supply for `add` to produce a working connector. oauth/local/none need none
// (oauth is handled interactively by claude's own MCP client; local is a path/scope grant, not a secret).
function secretsNeeded(entry) {
  return entry && entry.auth === 'key' && Array.isArray(entry.env) ? entry.env.slice() : [];
}

// Build the `claude mcp add ...` ARGV (array, never a shell string). Secrets are interpolated into --env/--header
// values here; because the caller execFile()s this array, those values never touch the user's interactive shell
// (no ~/.zsh_history entry, not visible in `ps` as a shell line). Throws if a required secret is missing.
function buildAddArgs(entry, secrets = {}) {
  if (!entry) throw new Error('no connector');
  const id = entry.id;
  if (entry.transport === 'http' || entry.transport === 'sse') {
    const args = ['mcp', 'add', '--transport', entry.transport, id, entry.url];
    if (entry.auth === 'key') {
      const f = (entry.env || [])[0];
      const tok = f ? secrets[f.key] : '';
      if (!tok) throw new Error('missing secret: ' + (f ? f.key : 'token'));
      args.push('--header', 'Authorization: Bearer ' + tok);
    }
    return args;
  }
  // stdio (npx/uvx): env flags first, then `-- <runner> <pkg...>`
  const args = ['mcp', 'add', id];
  for (const f of (entry.auth === 'key' ? entry.env : [])) {
    const v = secrets[f.key];
    if (!v) throw new Error('missing secret: ' + f.key);
    args.push('--env', f.key + '=' + v);
  }
  args.push('--');
  if (entry.transport === 'npx') args.push('npx', '-y', entry.pkg);
  else args.push('uvx', entry.pkg);
  return args;
}

// `claude mcp remove <id>` argv.
function buildRemoveArgs(entry) { return ['mcp', 'remove', (entry && entry.id) || '']; }

// Render an argv for display with every secret VALUE masked — so a preview/log can show the exact command shape
// without ever printing a token. Masks --env KEY=val (keeps KEY) and the bearer token in --header.
function redactArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--env' && typeof args[i + 1] === 'string') {
      const eq = args[i + 1].indexOf('=');
      out.push('--env', (eq > 0 ? args[i + 1].slice(0, eq) : args[i + 1]) + '=••••');
      i++;
    } else if (a === '--header' && typeof args[i + 1] === 'string') {
      out.push('--header', args[i + 1].replace(/(Bearer\s+)\S+/i, '$1••••'));
      i++;
    } else out.push(a);
  }
  return out;
}

// Static safety scan of a connector BEFORE it's added. Connectors are known packages/endpoints, so the risks are
// narrower than arbitrary skill markdown — but real: a stdio server runs code on your machine; a plaintext-http
// remote leaks credentials; an unverified package needs a source check. Returns { flags:[{level,why}] }.
function scan(entry) {
  const flags = [];
  const add = (level, why) => flags.push({ level, why });
  if (!entry) { add('danger', 'no connector'); return { flags }; }
  if (entry.transport === 'http' || entry.transport === 'sse') {
    let u; try { u = new URL(entry.url); } catch { add('danger', 'malformed endpoint URL'); return { flags }; }
    if (u.protocol !== 'https:' && !isLoopback(u.hostname)) add('danger', 'sends credentials/data to a remote host over plain http (not https)');
    if (isLoopback(u.hostname)) add('info', 'talks to a local service on this machine (' + u.hostname + ') — nothing leaves your box');
    else add('info', 'connects out to ' + u.hostname + (entry.auth === 'oauth' ? ' (you authorize in the browser; no key stored here)' : ''));
  } else {
    add('warn', 'runs a third-party package (' + entry.pkg + ') on your machine via ' + entry.transport + ' — owner turns only, never in a sandbox');
  }
  if (!entry.verified) add('warn', 'package/endpoint identifier not independently verified — confirm the source before you confirm the add');
  for (const f of secretsNeeded(entry)) add('info', 'needs a secret: ' + f.label + ' (you will be prompted; it is masked and never echoed)');
  return { flags };
}

// The full pre-enable security preview — the thing the rest of the field doesn't ship. Pure data; cli.js renders it.
function preview(entry, secrets = {}) {
  const runsCode = entry && (entry.transport === 'npx' || entry.transport === 'uvx');
  let cmd = [];
  try { cmd = redactArgs(buildAddArgs(entry, secrets)); } catch { cmd = redactArgs(buildAddArgs(entry, fakeSecrets(entry))); }
  return {
    id: entry.id, name: entry.name, category: entry.category,
    transport: entry.transport, auth: entry.auth,
    runsLocalCode: !!runsCode,
    endpoint: entry.url || null,
    secretsNeeded: secretsNeeded(entry).map((f) => f.label),
    ownerTurnsOnly: true,                       // always — sandboxed spawns are --strict-mcp-config
    flags: scan(entry).flags,
    command: 'claude ' + cmd.join(' '),
  };
}
// placeholder secret values so preview() can render the command shape even before the user has entered anything.
function fakeSecrets(entry) {
  const s = {}; for (const f of secretsNeeded(entry)) s[f.key] = 'x'; return s;
}

// ── MCP TOOL-POISONING GATE (pure) ───────────────────────────────────────────────────────────────
// scan() above judges only the RESOLVED COMMAND. A connector's sharper risk is the tool manifest the server
// advertises at RUNTIME — the names, descriptions and input schemas that are fed to the brain verbatim as
// instructions. Those are mutable and the documented tool-poisoning / rug-pull vector (an independent scan found
// poisoned tool descriptions on ~5.5% of ~1,900 public MCP servers). We treat every advertised string as UNTRUSTED
// skill text and run skillhub.scan() over it, then sha256-PIN the whole manifest (mirroring pluginhub's integrity
// pin) so a later description/schema swap after approval is detectable. Everything here is PURE + fail-closed and
// unit-tested; the impure stdio fetch + pin persistence live in mcpgate.js.

// The scannable text of ONE advertised tool: name + description + a stable stringify of its input schema. A poisoned
// description ("ignore all previous instructions…"), a zero-width/bidi smuggle, an exfil host, or a base-url override
// hidden in a schema default all live in exactly these strings.
function toolText(tool) {
  const t = (tool && typeof tool === 'object') ? tool : {};
  const name = String(t.name || '');
  const desc = String(t.description || '');
  let schema = '';
  try { schema = t.inputSchema == null ? '' : (typeof t.inputSchema === 'string' ? t.inputSchema : JSON.stringify(t.inputSchema)); } catch { schema = ''; }
  return name + '\n' + desc + '\n' + schema;
}

// Scan an advertised tool manifest for poisoning by REUSING skillhub.scan() over every tool's name+description+schema.
// FAIL-CLOSED: any DANGER flag ⇒ poisoned:true (refuse). Warns are surfaced but not fatal on their own (a legit
// description may merely mention "install"/"send"). Pure; tests drive it with hand-built tool arrays.
function scanTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const flags = [];
  for (const tool of list) {
    const name = String((tool && tool.name) || '(unnamed)').slice(0, 80);
    for (const f of skillhub.scan(toolText(tool)).flags) flags.push({ tool: name, level: f.level, why: f.why, sample: f.sample });
  }
  const dangers = flags.filter((f) => f.level === 'danger');
  return { ok: dangers.length === 0, poisoned: dangers.length > 0, flags, dangers: dangers.length, warns: flags.length - dangers.length,
    poisonedTools: [...new Set(dangers.map((f) => f.tool))] };
}

// Canonical, order-independent representation of the tool manifest — the bytes we sha256-pin. Tools sorted by name;
// each reduced to {name, description, inputSchema} with recursively key-sorted schema (auditChain.canonicalJSON), so
// a benign reorder of tools or schema keys never reads as drift, but ANY change to a name/description/schema does.
function canonicalToolManifest(tools) {
  const list = (Array.isArray(tools) ? tools : []).map((t) => ({
    name: String((t && t.name) || ''),
    description: String((t && t.description) || ''),
    inputSchema: (t && t.inputSchema != null) ? t.inputSchema : null,
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return auditChain.canonicalJSON(list);
}
function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// The pin record persisted alongside the connector after the owner approves a CLEAN manifest. Stores the overall sha
// AND a per-tool digest list, so a later drift can name WHICH tool changed (surface the diff) without re-storing the
// raw descriptions. Deterministic: pinManifest(tools).sha256 is stable across a reorder of the same tools.
function pinManifest(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const per = list.map((t) => ({ name: String((t && t.name) || ''), sha256: sha256Hex(canonicalToolManifest([t])) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { sha256: sha256Hex(canonicalToolManifest(list)), count: list.length, tools: per };
}

// Recompute the pin of the CURRENT manifest and compare it to the stored pin. FAIL-CLOSED: any mismatch ⇒
// drifted:true (a rug-pull — a tool's description/schema changed, or a tool was added/removed, AFTER the owner
// approved it). Names the changed/added/removed tools so cli.js can surface the diff and demand re-approval. Pure.
function manifestDrift(tools, pinned) {
  const now = pinManifest(tools);
  const prev = (pinned && typeof pinned === 'object') ? pinned : { sha256: '', tools: [] };
  if (!prev.sha256) return { ok: false, drifted: true, reason: 'no prior pin — never approved', got: now.sha256, pinned: '', added: now.tools.map((t) => t.name), removed: [], changed: [] };
  const prevMap = new Map((prev.tools || []).map((t) => [t.name, t.sha256]));
  const nowMap = new Map((now.tools || []).map((t) => [t.name, t.sha256]));
  const added = [...nowMap.keys()].filter((n) => !prevMap.has(n));
  const removed = [...prevMap.keys()].filter((n) => !nowMap.has(n));
  const changed = [...nowMap.keys()].filter((n) => prevMap.has(n) && prevMap.get(n) !== nowMap.get(n));
  const ok = now.sha256 === String(prev.sha256).toLowerCase();
  return { ok, drifted: !ok, got: now.sha256, pinned: String(prev.sha256).toLowerCase(), added, removed, changed };
}

module.exports = {
  registryPath, slugify, parse, load, search, find, categories,
  secretsNeeded, buildAddArgs, buildRemoveArgs, redactArgs, scan, preview, isLoopback,
  toolText, scanTools, canonicalToolManifest, pinManifest, manifestDrift,
  TRANSPORTS, AUTHS,
};
