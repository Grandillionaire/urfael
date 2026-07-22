'use strict';
// app/plugin-importcore.js — the PURE core of the foreign-plugin importer. It reads an OpenClaw / Hermes plugin
// MANIFEST as DATA only (it NEVER require()s or execs foreign code — that is the whole thesis: ~20% of ClawHub
// shipped as in-process malware), and classifies each declared surface into one of three buckets:
//   • 'skill'      — a bundled SKILL.md → routed to the existing skill installer (scanned, never executed)
//   • 'mcp'        — a DECLARED external MCP server → a draft urfael.plugin/v1 manifest pointing at it
//   • 'unmappable' — in-process code (hooks, commands, providers, channels, ctx.* calls) → REFUSED, with a reason
// Fail-closed (lib.resolveProfile style): anything not positively recognized as out-of-process-mappable is refused.
// A tool name + JSON Schema is a contract, NOT a runnable server, so a plugin shipping only in-process tools with
// no external server command is REFUSED, never stubbed. No fs/net/exec here; the runner does I/O.
const { isPrivateHost } = require('./lib');

function slugId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48); }
function slugTool(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48); }

// stripJson5(text) → JSON.parse-able text: remove // and /* */ comments (string-aware) + trailing commas. Total,
// never throws. If the result still won't JSON.parse (single quotes, unquoted keys), the caller REFUSES (never eval).
function stripJson5(text) {
  const s = String(text == null ? '' : text); let out = ''; let i = 0; const n = s.length; let q = null;
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (q) { out += c; if (c === '\\' && i + 1 < n) { out += d; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { i += 2; while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// parseYamlSubset(text) → flat scalars + simple top-level lists; a nested/non-trivial value is recorded in _opaque,
// never guessed (drives the refuse rule). Total.
function parseYamlSubset(text) {
  const out = { _opaque: [] }; let curList = null;
  for (const raw of String(text || '').split(/\r?\n/)) {   // CRLF-safe: a Windows-authored plugin.yaml must not silently parse to nothing
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = (line.match(/^\s*/) || [''])[0].length;
    const li = line.match(/^\s*-\s+(.+)$/);
    if (li && curList) { curList.push(li[1].trim().replace(/^["']|["']$/g, '')); continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv && indent === 0) { const k = kv[1]; const v = kv[2].trim(); if (!v) { curList = []; out[k] = curList; } else { curList = null; out[k] = v.replace(/^["']|["']$/g, ''); } }
    else if (indent > 0 && curList === null) out._opaque.push(line.trim());
  }
  return out;
}

// detectFormat(fileNames) → which foreign format a plugin dir is, by signature file.
function detectFormat(files) {
  const f = (files || []).map((x) => String(x).toLowerCase());
  if (f.includes('openclaw.plugin.json')) return 'openclaw';
  if (f.includes('plugin.yaml') || f.includes('plugin.yml')) return 'hermes-plugin';
  if (f.includes('skill.md')) return 'skill-md';
  return 'unknown';
}

// pull a single public FQDN from a url/host string, or '' (drops private/loopback; never a wildcard).
function publicHost(s) {
  let h = String(s || '').trim();
  try { if (/^[a-z]+:\/\//i.test(h)) h = new URL(h).hostname; } catch { return ''; }
  h = h.replace(/^\[|\]$/g, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+$/i.test(h) || h.includes('*')) return '';   // exact hosts only, never a wildcard
  if (isPrivateHost(h)) return '';                                // drop loopback/RFC1918/etc
  return h.toLowerCase();
}
function envRef(s) { const r = String(s || '').trim(); return /^[A-Z][A-Z0-9_]{0,63}$/.test(r) ? r : ''; }

// ── parse a foreign manifest into a normalized descriptor (DATA only). ──────────────────────────────
function parseOpenClaw(pluginJson5, pkgJson, openclawJson) {
  const d = { platform: 'openclaw', id: '', name: '', version: '', description: '', tools: [], mcpServers: [], hosts: [], secretRefs: [], skills: [], unmappable: [] };
  let m = {}; try { m = JSON.parse(stripJson5(pluginJson5 || '{}')) || {}; } catch { return { ...d, parseError: true }; }
  let pkg = {}; try { pkg = JSON.parse(pkgJson || '{}') || {}; } catch {}
  let oc = {}; try { oc = JSON.parse(stripJson5(openclawJson || '{}')) || {}; } catch {}
  d.id = slugId(m.id || m.name || (pkg && pkg.name) || '');
  d.name = String(m.name || d.id || '').slice(0, 60);
  d.version = String(m.version || (pkg && pkg.version) || '0.0.0');
  d.description = String(m.description || '').slice(0, 200);
  const contracts = m.contracts || {};
  for (const t of (Array.isArray(contracts.tools) ? contracts.tools : (Array.isArray(m.tools) ? m.tools : []))) { const name = t && (t.name || t.id); if (name) d.tools.push({ name: String(name), description: String((t && t.description) || '').slice(0, 200) }); }
  // declared EXTERNAL mcp servers (the only thing that yields a runnable entry)
  const servers = (oc.mcp && oc.mcp.servers) || (m.mcp && m.mcp.servers) || {};
  for (const key of Object.keys(servers || {})) { const sv = servers[key] || {}; if (Array.isArray(sv.args) || sv.command) d.mcpServers.push({ cmd: [sv.command, ...(Array.isArray(sv.args) ? sv.args : [])].filter(Boolean).map(String), url: '' }); else if (sv.url) d.mcpServers.push({ cmd: null, url: String(sv.url) }); }
  // network evidence
  for (const h of [...(Array.isArray(contracts.webFetchProviders) ? contracts.webFetchProviders : []), ...(Array.isArray(contracts.webSearchProviders) ? contracts.webSearchProviders : []), ...(Array.isArray(m.providerEndpoints) ? m.providerEndpoints : [])]) { const p = publicHost(h && (h.host || h.url || h)); if (p) d.hosts.push(p); }
  for (const e of (Array.isArray(m.channelEnvVars) ? m.channelEnvVars : []).concat(Array.isArray(m.secretProviderIntegrations) ? m.secretProviderIntegrations : [])) { const r = envRef(e && (e.env || e)); if (r) d.secretRefs.push(r); }
  for (const s of (Array.isArray(m.skills) ? m.skills : [])) d.skills.push(String(s && (s.path || s.file || s)));
  // in-process surfaces → unmappable, each with a reason
  for (const k of ['providers', 'channels', 'cliBackends', 'middleware', 'policies']) if (m[k] || contracts[k + 'Providers'] || contracts[k]) d.unmappable.push({ kind: k, reason: 'OpenClaw ' + k + ': in-process implementation, no MCP/markdown form' });
  if (contracts.gatewayMethodDispatch) d.unmappable.push({ kind: 'gatewayMethodDispatch', reason: 'in-process gateway route' });
  return d;
}
function parseHermes(pluginYaml, configYaml) {
  const d = { platform: 'hermes', id: '', name: '', version: '', description: '', tools: [], mcpServers: [], hosts: [], secretRefs: [], skills: [], unmappable: [] };
  const y = parseYamlSubset(pluginYaml || '');
  d.id = slugId(y.name || y.id || ''); d.name = String(y.name || d.id || '').slice(0, 60);
  d.version = String(y.version || '0.0.0'); d.description = String(y.description || '').slice(0, 200);
  for (const t of (Array.isArray(y.provides_tools) ? y.provides_tools : [])) if (t) d.tools.push({ name: String(t), description: '' });
  for (const e of (Array.isArray(y.requires_env) ? y.requires_env : [])) { const r = envRef(e); if (r) d.secretRefs.push(r); }
  if (Array.isArray(y.provides_hooks) && y.provides_hooks.length) d.unmappable.push({ kind: 'hooks', reason: 'Hermes register_hook(' + y.provides_hooks.join(',') + '): no MCP event bus; a hook can mutate the host prompt' });
  if (String(y.kind || '') === 'model-provider' || String(y.kind || '') === 'platform') d.unmappable.push({ kind: y.kind, reason: 'Hermes kind:' + y.kind + ' wires into host routing/channel pipelines' });
  const cfg = parseYamlSubset(configYaml || '');
  for (const k of Object.keys(cfg)) { if (k === '_opaque') continue; const v = cfg[k]; if (Array.isArray(v) && /mcp_servers/i.test(k)) for (const cmd of v) d.mcpServers.push({ cmd: String(cmd).split(/\s+/).filter(Boolean), url: '' }); }
  return d;
}

// ── classify + map. mapToManifest → { manifest|null, refusals[], routedSkills[] }. Fail-closed. ──────
function classifySurface(d) {
  const out = [];
  for (const s of (d.skills || [])) out.push({ kind: 'skill', ref: s });
  const hasServer = (d.mcpServers || []).some((s) => Array.isArray(s.cmd) && s.cmd.length);
  if (d.tools && d.tools.length) out.push(hasServer ? { kind: 'mcp' } : { kind: 'unmappable', reason: 'in-process tools with no external MCP server command to point at' });
  for (const u of (d.unmappable || [])) out.push({ kind: 'unmappable', reason: u.reason });
  if (d.parseError) out.push({ kind: 'unmappable', reason: 'manifest did not parse as JSON/JSON5 — refusing rather than guessing' });
  return out;
}
function refusalsFor(d) { return classifySurface(d).filter((c) => c.kind === 'unmappable').map((c) => c.reason); }

function mapToManifest(d) {
  const refusals = refusalsFor(d);
  const routedSkills = (d.skills || []).slice();
  if (d.parseError) return { manifest: null, refusals, routedSkills };
  const server = (d.mcpServers || []).find((s) => Array.isArray(s.cmd) && s.cmd.length && s.cmd.every((a) => typeof a === 'string' && a && !/[\n\r\0]/.test(a)));
  if (!server) return { manifest: null, refusals, routedSkills };   // no runnable server → nothing to emit (only skills/refusals)
  const id = (d.id && /^[a-z0-9][a-z0-9-]{1,47}$/.test(d.id)) ? d.id : 'imported-plugin';   // always a loader-valid id, even from a degenerate foreign one
  const manifest = {
    schema: 'urfael.plugin/v1', id, name: d.name || id, version: d.version || '0.0.0', runtime: 'mcp-native',
    entry: { transport: 'stdio', cmd: server.cmd.slice() },
    capabilities: {
      brain: { tools: (d.tools || []).map((t) => ({ name: slugTool(t.name), description: t.description || '' })).filter((t) => t.name) },
      net: [...new Set((d.hosts || []).map(publicHost).filter(Boolean))].map((host) => ({ host, why: 'declared by the foreign plugin' })),
      secret: [...new Set((d.secretRefs || []).map(envRef).filter(Boolean))].map((ref) => ({ ref, why: 'declared by the foreign plugin' })),
      // fs / exec / channel are NEVER auto-granted from a foreign manifest — the owner adds those by hand.
    },
    publisher: { id: d.platform + '-import', keyFingerprint: '' },
    provenance: { sourceUrl: '', commit: '' },
    _draft: true,   // UNSIGNED, DISABLED draft; re-enters the unchanged native six-gate pipeline
  };
  return { manifest, refusals, routedSkills };
}

module.exports = { slugId, slugTool, stripJson5, parseYamlSubset, detectFormat, publicHost, envRef, parseOpenClaw, parseHermes, classifySurface, refusalsFor, mapToManifest };
