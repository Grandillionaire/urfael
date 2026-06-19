'use strict';
// app/pluginhub.js — the Urfael plugin engine. A plugin is the most powerful extension surface (it can ship
// tools, reach scoped files, call allowlisted hosts), so it gets the most paranoid handling in the codebase.
//
// THE TWO LAWS THAT NEVER BEND:
//   1. No inbound port. A plugin is SPAWNED by the daemon as a stdio MCP server; it never listens. The moat holds.
//   2. Zero capability by default. An empty manifest grants nothing. Every power is DECLARED, then GRANTED by the
//      owner on a 0600-socket turn, and the grant is COMPILED into the runtime confinement (the Docker --network
//      none cell's mounts + the brain's tool allowlist). The manifest is the enforcement spec, not documentation.
//
// Like skillhub.js and connectors.js this module is PURE and dependency-free: it parses/validates a manifest
// (fail-closed — junk drops, never throws), statically scans the bundle, verifies a sha256 pin + an ed25519
// signature (seal.js), computes the declared→granted capability diff, and BUILDS the docker cell argv + the
// per-plugin MCP config as data. It never require()s a plugin, never runs docker, never opens a socket. The
// daemon/cli compose these outputs. Everything here is unit-tested and frozen as a benchmark class.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const seal = require('./seal');
const skillhub = require('./skillhub');
const { isPrivateHost } = require('./lib');

const VAULT = path.join(os.homedir(), process.env.URFAEL_VAULT_DIR || 'Urfael');
const PLUGINS_DIR = path.join(VAULT, '_urfael', 'plugins');
const SCHEMA = 'urfael.plugin/v1';
const CAP_KINDS = ['fs', 'net', 'exec', 'secret', 'channel', 'brain'];
const MEM_CAP_MB = 512;             // hard ceiling regardless of what the manifest asks for
const PIDS_CAP = 256;

// The fs deny-oracle: a plugin must never be granted a path into a credential store or outside the vault. We reuse
// skillhub's scanner as the authority — if a path string trips its 'targets a credentials/secret store' flag, it's
// refused. (skillhub.SECRET_PATH is internal, so we drive it through the public scan() to avoid duplicating the regex.)
function pathHitsSecretStore(p) {
  return skillhub.scan(String(p || '')).flags.some((f) => /credentials\/secret store|~\/\.ssh|under \/etc/.test(f.why));
}
// A granted fs path is 'vault:<relative>' and must stay strictly inside the vault — no '..', no absolute escape.
function safeVaultRel(spec) {
  const s = String(spec || '');
  if (!/^vault:/.test(s)) return null;
  const rel = s.slice('vault:'.length).replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return null;
  if (pathHitsSecretStore(rel) || pathHitsSecretStore('~/' + rel)) return null;
  const resolved = path.resolve(VAULT, rel);
  if (resolved !== VAULT && !resolved.startsWith(VAULT + path.sep)) return null;   // escaped the vault
  return rel;
}

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// ── parse + validate a manifest. Fail-closed: a bad top-level shape returns null; a bad individual capability
//    entry is DROPPED (never the whole plugin), mirroring connectors.parse. Unknown fields are ignored, not trusted.
function parse(text) {
  let j;
  if (typeof text === 'object' && text) j = text;
  else { try { j = JSON.parse(String(text)); } catch { return null; } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (j.schema !== SCHEMA) return null;                                       // unknown major → refuse outright
  const id = slugify(j.id || j.name || '');
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(id)) return null;
  if (j.version != null && !SEMVER.test(String(j.version))) return null;
  const runtime = ['mcp-native', 'node'].includes(j.runtime) ? j.runtime : null;
  if (!runtime) return null;                                                  // python/wasm reserved for v2
  // entry must be a stdio argv array of plain tokens (never a shell string)
  const cmd = j.entry && j.entry.transport === 'stdio' && Array.isArray(j.entry.cmd) ? j.entry.cmd : null;
  if (!cmd || !cmd.length || !cmd.every((a) => typeof a === 'string' && a.length && !/[\n\r\0]/.test(a))) return null;

  const m = {
    schema: SCHEMA, id,
    name: String(j.name || id).slice(0, 60),
    description: String(j.description || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').slice(0, 200),
    version: j.version ? String(j.version) : '0.0.0',
    author: String(j.author || '').slice(0, 80),
    license: String(j.license || '').slice(0, 40),
    runtime,
    entry: { transport: 'stdio', cmd: cmd.slice() },
    caps: { fs: [], net: [], exec: [], secret: [], channel: [], brain: { tools: [] } },
    limits: { memMb: Math.min(MEM_CAP_MB, Number((j.limits && j.limits.memMb) || MEM_CAP_MB) || MEM_CAP_MB) },
    activation: { ownerTurnsOnly: true },                                     // forced; recomputed below
    integrity: (j.integrity && typeof j.integrity === 'object') ? { sha256: String(j.integrity.sha256 || '').toLowerCase() } : { sha256: '' },
    publisher: (j.publisher && typeof j.publisher === 'object') ? { id: String(j.publisher.id || '').slice(0, 60), keyFingerprint: String(j.publisher.keyFingerprint || '').slice(0, 80) } : { id: '', keyFingerprint: '' },
    provenance: (j.provenance && typeof j.provenance === 'object') ? { sourceUrl: /^https:\/\//i.test(j.provenance.sourceUrl || '') ? String(j.provenance.sourceUrl) : '', commit: String(j.provenance.commit || '').slice(0, 64) } : { sourceUrl: '', commit: '' },
    signature: typeof j.signature === 'string' ? j.signature : '',
  };

  const c = (j.capabilities && typeof j.capabilities === 'object') ? j.capabilities : {};
  // fs: keep only vault-relative, non-secret, non-escaping paths
  for (const e of (Array.isArray(c.fs) ? c.fs : [])) {
    if (!e || typeof e !== 'object') continue;
    const mode = e.mode === 'write' ? 'write' : 'read';
    const rel = safeVaultRel(e.path);
    if (!rel) continue;                                                       // dropped by the deny-oracle, never the whole plugin
    m.caps.fs.push({ mode, path: 'vault:' + rel, why: String(e.why || '').slice(0, 120) });
  }
  // net: exact-FQDN allowlist, https/loopback only, never a private host literal
  for (const e of (Array.isArray(c.net) ? c.net : [])) {
    if (!e || typeof e !== 'object') continue;
    const host = String(e.host || '').toLowerCase().trim();
    if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253) continue;
    if (isPrivateHost(host)) continue;                                        // a manifest can't pre-allow loopback/RFC1918
    const ports = (Array.isArray(e.ports) ? e.ports : [443]).map((p) => parseInt(p, 10)).filter((p) => p > 0 && p < 65536);
    m.caps.net.push({ host, ports: ports.length ? ports : [443], why: String(e.why || '').slice(0, 120) });
  }
  // exec: a named host binary token only (no path, no metachars)
  for (const e of (Array.isArray(c.exec) ? c.exec : [])) {
    if (!e || typeof e !== 'object') continue;
    const bin = String(e.bin || '');
    if (!/^[a-zA-Z0-9][\w.-]{0,39}$/.test(bin)) continue;
    m.caps.exec.push({ bin, why: String(e.why || '').slice(0, 120) });
  }
  // secret: a REFERENCE name only — never a value
  for (const e of (Array.isArray(c.secret) ? c.secret : [])) {
    if (!e || typeof e !== 'object') continue;
    const ref = String(e.ref || '');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(ref)) continue;
    m.caps.secret.push({ ref, why: String(e.why || '').slice(0, 120) });
  }
  // channel: one-way owner-only egress kinds only
  for (const e of (Array.isArray(c.channel) ? c.channel : [])) {
    if (!e || typeof e !== 'object') continue;
    const emit = ['notify', 'push'].includes(e.emit) ? e.emit : null;
    if (!emit) continue;
    m.caps.channel.push({ emit, why: String(e.why || '').slice(0, 120) });
  }
  // brain.tools: LLM-visible MCP tools, names auto-prefixed mcp_<id>_<tool>
  const bt = c.brain && Array.isArray(c.brain.tools) ? c.brain.tools : [];
  for (const t of bt) {
    if (!t || typeof t !== 'object') continue;
    const name = String(t.name || '');
    if (!/^[a-z0-9][a-z0-9_]{0,47}$/.test(name)) continue;
    m.caps.brain.tools.push({ name, toolName: 'mcp_' + id + '_' + name, description: String(t.description || '').slice(0, 200) });
  }

  // any host-reaching capability FORCES owner-turns-only (it can never be exposed to a sandboxed/remote turn)
  m.activation.ownerTurnsOnly = true;
  m.hostReaching = !!(m.caps.fs.length || m.caps.net.length || m.caps.exec.length || m.caps.secret.length);
  return m;
}

function load(file) { let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch { return null; } return parse(t); }

// ── static safety scan of the whole bundle. Reuse skillhub.scan over every text asset + the manifest's own strings;
//    NEVER executes anything. Returns { flags:[{level,why,sample}] }.
function scanBundle(manifest, assets = {}) {
  const flags = [];
  if (!manifest) return { flags: [{ level: 'danger', why: 'unparseable manifest' }] };
  // scan the manifest's free-text + the entry argv (a hostile entry could be a curl|sh dropper)
  const blob = [manifest.description, (manifest.entry.cmd || []).join(' '),
    ...manifest.caps.fs.map((f) => f.why), ...manifest.caps.net.map((n) => n.why)].join('\n');
  for (const f of skillhub.scan(blob).flags) flags.push(f);
  for (const name of Object.keys(assets)) {
    const r = skillhub.scan(String(assets[name] || ''));
    for (const f of r.flags) flags.push({ ...f, why: name + ': ' + f.why });
  }
  return { flags };
}

// ── integrity: the bundle bytes must match the pinned sha256 before anything is shown or run.
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function verifyIntegrity(bundleBytes, expectedSha) {
  const got = sha256(Buffer.isBuffer(bundleBytes) ? bundleBytes : Buffer.from(String(bundleBytes)));
  const ok = !!expectedSha && got.toLowerCase() === String(expectedSha).toLowerCase();
  return { ok, got, expected: String(expectedSha || '').toLowerCase() };
}

// canonical manifest bytes for signing/verifying: deterministic JSON of the manifest MINUS the signature field.
function canonicalManifest(manifest) {
  const clone = JSON.parse(JSON.stringify(manifest || {}));
  delete clone.signature;
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sort(v[k]); return o; }
    return v;
  };
  return JSON.stringify(sort(clone));
}
// ed25519: the manifest must be signed by the publisher's pinned key (seal.js). TOFU: first install pins the
// fingerprint; later versions must match it or stay disabled pending explicit owner re-consent.
function verifySignature(manifest, publicPem) {
  if (!manifest || !manifest.signature || !publicPem) return { ok: false, reason: 'unsigned' };
  let ok = false; try { ok = seal.verify(publicPem, canonicalManifest(manifest), manifest.signature); } catch { ok = false; }
  const fp = (() => { try { return seal.fingerprint(publicPem); } catch { return ''; } })();
  const pinned = manifest.publisher && manifest.publisher.keyFingerprint;
  const fpOk = !pinned || (fp && (fp === pinned || ('sha256:' + fp) === pinned || fp === String(pinned).replace(/^sha256:/, '')));
  return { ok: !!(ok && fpOk), reason: ok ? (fpOk ? 'ok' : 'key-fingerprint-mismatch') : 'bad-signature', fingerprint: fp };
}

// ── capability model: DECLARED (manifest) vs GRANTED (owner-approved subset). grantDiff returns the capabilities a
//    (new) manifest requests BEYOND a prior grant — an upgrade that widens power stays disabled until re-consented.
function declaredCaps(manifest) {
  if (!manifest) return [];
  const out = [];
  for (const f of manifest.caps.fs) out.push({ kind: 'fs', key: f.mode + ' ' + f.path });
  for (const n of manifest.caps.net) out.push({ kind: 'net', key: n.host + ':' + n.ports.join(',') });
  for (const e of manifest.caps.exec) out.push({ kind: 'exec', key: e.bin });
  for (const s of manifest.caps.secret) out.push({ kind: 'secret', key: s.ref });
  for (const c of manifest.caps.channel) out.push({ kind: 'channel', key: c.emit });
  for (const t of manifest.caps.brain.tools) out.push({ kind: 'brain', key: t.name });
  return out;
}
function grantDiff(priorGrantCaps, manifest) {
  const prior = new Set((priorGrantCaps || []).map((c) => c.kind + '|' + c.key));
  return declaredCaps(manifest).filter((c) => !prior.has(c.kind + '|' + c.key));
}

// host-reaching grant = anything that needs the Docker cell (fs/net/exec/secret). brain/channel alone don't.
function hasHostGrant(grant) {
  const g = grant || {};
  return !!((g.fs && g.fs.length) || (g.net && g.net.length) || (g.exec && g.exec.length) || (g.secret && g.secret.length));
}
// needs the BROKER transport (a mounted unix socket) = net or secret. fs/exec alone need only the cell mount.
function hostNeedsBroker(grant) {
  const g = grant || {};
  return !!((g.net && g.net.length) || (g.secret && g.secret.length));
}
function vaultHostPath(rel) { return path.join(VAULT, String(rel || '').replace(/^vault:/, '')); }

// ── buildCellArgs: the `docker run …` ARGV (array, never a shell string). DEFAULT-DENY: an empty grant yields a
//    --network none, all-caps-dropped, read-only cell with NO bind mounts beyond a tmpfs scratch. Only GRANTED fs
//    paths become bind mounts; net never adds host networking (the egress proxy is a separate seam); secrets are
//    never in the argv. This function IS the enforcement — what isn't granted produces no mount, full stop.
function buildCellArgs(manifest, grant = {}, opts = {}) {
  const mem = Math.min(MEM_CAP_MB, (manifest && manifest.limits && manifest.limits.memMb) || MEM_CAP_MB);
  const args = ['run', '--rm', '-i', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:size=64m',
    '--memory', mem + 'm', '--pids-limit', String(PIDS_CAP)];
  for (const f of (grant.fs || [])) {
    const rel = safeVaultRel(f.path);
    if (!rel) continue;                                                       // belt-and-suspenders: re-validate at build time
    args.push('-v', vaultHostPath(rel) + ':/vault/' + rel + ':' + (f.mode === 'write' ? 'rw' : 'ro'));
  }
  // a net/secret grant gets ONE more thing: the per-plugin 0600 broker socket, read-write, as its sole egress.
  // The cell still has --network none — this unix socket is the only way out, and the daemon brokerd vets every call.
  if (opts.brokerSock && hostNeedsBroker(grant)) args.push('-v', opts.brokerSock + ':/run/urfael/broker.sock');
  args.push(opts.image || 'urfael-plugin:latest');
  for (const a of (manifest && manifest.entry && manifest.entry.cmd) || []) args.push(a);
  return args;
}

// ── buildMcpConfig: the per-plugin .mcp.<id>.json the daemon writes and attaches via --mcp-config on OWNER turns
//    only. A host-reaching plugin is launched as `docker run <cell>`; a pure brain:tools plugin (no host grant) may
//    run as a plain stdio child (still scopedEnv'd, still owner-only). Secrets are NEVER placed in env here.
function buildMcpConfig(manifest, grant = {}, opts = {}) {
  if (!manifest) return { mcpServers: {} };
  const server = hasHostGrant(grant)
    ? { command: opts.docker || 'docker', args: buildCellArgs(manifest, grant, opts), env: {} }
    : { command: manifest.entry.cmd[0], args: manifest.entry.cmd.slice(1), env: {} };
  if (opts.bundleDir && !hasHostGrant(grant)) server.cwd = opts.bundleDir;   // the brain-tools child runs from its own bundle dir
  return { mcpServers: { [manifest.id]: server } };
}

// the brain tool names this plugin exposes (added to --allowedTools on owner turns; absent everywhere else).
function pluginTools(manifest) { return manifest ? manifest.caps.brain.tools.map((t) => t.toolName) : []; }

// redact any secret value out of a rendered command/preview (defense in depth; v1 never puts a value in the argv).
function redact(s, secrets = []) {
  let out = String(s);
  for (const v of secrets) if (v) out = out.split(v).join('••••');
  return out;
}

// ── the pre-enable preview — what the owner consents to. Pure data; cli.js renders it. Never contains a secret value.
function preview(manifest, grant) {
  const g = grant || grantFromManifest(manifest);                            // default proposed grant = everything declared
  const tier = hasHostGrant(g) ? 'docker-cell (host-reaching)' : (manifest && manifest.caps.brain.tools.length ? 'mcp-tools-only (no host reach)' : 'inert');
  return {
    id: manifest && manifest.id, name: manifest && manifest.name,
    runtime: manifest && manifest.runtime,
    tier,
    ownerTurnsOnly: true,
    requiresDocker: hasHostGrant(g),
    capabilities: declaredCaps(manifest),
    tools: pluginTools(manifest),
    fsMounts: (g.fs || []).map((f) => f.mode + ' ' + f.path),
    netHosts: (g.net || []).map((n) => n.host),
    secrets: (manifest ? manifest.caps.secret : []).map((s) => s.ref),
    signed: !!(manifest && manifest.signature),
    shaPinned: !!(manifest && manifest.integrity && manifest.integrity.sha256),
    cellArgs: redact(buildCellArgs(manifest, g).join(' ')),
  };
}
// a full grant proposed straight from the manifest's declared caps (the owner can narrow it before consent).
function grantFromManifest(manifest) {
  if (!manifest) return {};
  return { fs: manifest.caps.fs.slice(), net: manifest.caps.net.slice(), exec: manifest.caps.exec.slice(),
    secret: manifest.caps.secret.slice(), channel: manifest.caps.channel.slice(), brain: { tools: manifest.caps.brain.tools.slice() } };
}

// ── registry index (signed-publisher-ranked, sha-pinned; sibling of the skill hub). Pure, fail-soft parse.
function parseIndex(text) {
  let j; try { j = JSON.parse(String(text)); } catch { return []; }
  const list = Array.isArray(j) ? j : (j && Array.isArray(j.plugins) ? j.plugins : []);
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = slugify(e.id || e.name || '');
    if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(id)) continue;
    if (typeof e.url !== 'string' || !/^https:\/\//i.test(e.url)) continue;
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(e.sha256)) continue;   // a hub entry MUST be pinned
    out.push({ id, title: String(e.title || e.name || id).slice(0, 80), description: String(e.description || '').slice(0, 200),
      url: e.url, sha256: e.sha256.toLowerCase(), publisher: String(e.publisher || '').slice(0, 60),
      keyFingerprint: String(e.keyFingerprint || '').slice(0, 80), caps: Array.isArray(e.caps) ? e.caps.map((x) => String(x).slice(0, 16)).slice(0, 12) : [] });
  }
  return out;
}
function search(list, q) { const s = String(q || '').toLowerCase().trim(); return !s ? list : list.filter((e) => (e.id + ' ' + e.title + ' ' + e.description + ' ' + (e.caps || []).join(' ')).toLowerCase().includes(s)); }
function find(list, id) { const k = slugify(id); return (list || []).find((e) => e.id === k) || null; }

module.exports = {
  VAULT, PLUGINS_DIR, SCHEMA, CAP_KINDS, MEM_CAP_MB,
  slugify, safeVaultRel, parse, load, scanBundle, sha256, verifyIntegrity, canonicalManifest, verifySignature,
  declaredCaps, grantDiff, hasHostGrant, hostNeedsBroker, buildCellArgs, buildMcpConfig, pluginTools, redact, preview,
  grantFromManifest, parseIndex, search, find,
};
