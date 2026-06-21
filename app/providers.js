'use strict';
// app/providers.js — first-class model-provider management. The brain is the `claude` CLI, which any
// Anthropic-Messages-API endpoint can back via ANTHROPIC_BASE_URL, so "use any model" = managing those endpoints
// like connectors, not hosting weights. This is the PURE engine (twin of connectors.js): parse/validate a registry
// (fail-soft — a hostile registry can only ever yield FEWER providers, never a malformed env write), and RESOLVE a
// chosen provider into the exact env delta the daemon forwards to every spawn. No I/O, no secret prompting, no
// process spawn (those live in cli.js). Everything here is unit-tested + frozen, incl. the drift guard that every
// var resolveEnv can emit is one the daemon already forwards.
const fs = require('fs');
const path = require('path');
const { isLoopback } = require('./connectors');

const KINDS = new Set(['anthropic', 'openai', 'gemini', 'ollama', 'bedrock', 'vertex']);
const AUTHS = new Set(['none', 'key', 'local', 'awschain', 'oauth']);
const PROXIES = new Set(['none', 'router', 'litellm']);
// The COMPLETE set of routing vars a switch manages. MUST stay a subset of the daemon's forwarded allowlist
// (PROVIDER_ENV ∪ {URFAEL_OPUS_MODEL, URFAEL_SONNET_MODEL}); the providers test freezes that. Cleared on every
// switch so one provider never leaks into the next.
const MANAGED = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_BEARER_TOKEN_BEDROCK',
  'URFAEL_OPUS_MODEL', 'URFAEL_SONNET_MODEL',
];
const MANAGED_SET = new Set(MANAGED);

function registryPath() { return process.env.URFAEL_PROVIDERS_INDEX || path.join(__dirname, '..', 'config', 'providers.json'); }
function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48); }
// routing tiers: an INDICATIVE 1..5 hint (cost 1=cheapest..5=premium · speed 1=slow..5=fastest · quality 1=weak..
// 5=Claude-grade). 0 = unknown. Pure metadata that drives app/router.js; never an env var, so the drift guard is safe.
function clampTier(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 0; }

// parse + validate. Fail-soft: drops any malformed / plain-http-remote / flag-smuggling-authEnv row, never throws.
function parse(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(j) ? j : (j && Array.isArray(j.providers) ? j.providers : []);
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = slugify(e.id || ''); if (!/^[a-z0-9-]+$/.test(id)) continue;
    const kind = String(e.kind || '').toLowerCase(); if (!KINDS.has(kind)) continue;
    const authKind = AUTHS.has(String(e.authKind || '').toLowerCase()) ? String(e.authKind).toLowerCase() : 'none';
    const proxy = PROXIES.has(String(e.proxy || '').toLowerCase()) ? String(e.proxy).toLowerCase() : 'none';
    let baseUrl = String(e.baseUrl || '');
    if (baseUrl) { let u; try { u = new URL(baseUrl); } catch { continue; } if (u.protocol !== 'https:' && !isLoopback(u.hostname)) continue; }   // never a plain-http remote
    // the secret var NAME (for key auth) must be a real env-var name AND one we forward — no flag smuggling, no drift
    let authEnv = '';
    if (e.authEnv != null) { authEnv = String(e.authEnv); if (!/^[A-Z][A-Z0-9_]*$/.test(authEnv) || !MANAGED_SET.has(authEnv)) continue; }
    if (authKind === 'key' && !authEnv) authEnv = 'ANTHROPIC_AUTH_TOKEN';   // sensible default for a proxy/OpenAI-shaped key
    const models = [];
    for (const m of (Array.isArray(e.models) ? e.models : [])) {
      if (!m || typeof m !== 'object' || !m.id) continue;
      models.push({ id: String(m.id).slice(0, 80), role: m.role === 'small' ? 'small' : 'big', ctx: Number(m.ctx) || 0, tools: m.tools !== false, cost: clampTier(m.cost), speed: clampTier(m.speed), quality: clampTier(m.quality) });
    }
    out.push({
      id, label: String(e.label || id).slice(0, 60), kind, baseUrl, authKind, proxy, authEnv,
      big_model: String(e.big_model || '').slice(0, 80), small_model: String(e.small_model || '').slice(0, 80),
      authLabel: String(e.authLabel || (authEnv || 'API key')).slice(0, 80), localToken: String(e.localToken || '').slice(0, 40),
      proxyHint: String(e.proxyHint || '').slice(0, 200), note: String(e.note || '').replace(/\s+/g, ' ').slice(0, 200),
      models, verified: e.verified === true,
      cost: clampTier(e.cost), speed: clampTier(e.speed), quality: clampTier(e.quality), flatRate: e.flatRate === true,
      fallbacks: Array.isArray(e.fallbacks) ? [...new Set(e.fallbacks.map(slugify).filter((s) => /^[a-z0-9-]+$/.test(s)))].slice(0, 6) : [],
    });
  }
  return out;
}
function load(file) { let t = ''; try { t = fs.readFileSync(file || registryPath(), 'utf8'); } catch { return []; } return parse(t); }
function search(list, q) { const s = String(q || '').toLowerCase().trim(); return !s ? list : list.filter((p) => (p.id + ' ' + p.label + ' ' + p.kind + ' ' + p.note).toLowerCase().includes(s)); }
function find(list, id) { const k = slugify(id); return (list || []).find((p) => p.id === k) || null; }

// chain(list, id) → the ordered list of provider ENTRIES to try: [primary, ...its fallbacks], resolved to real
// entries, deduped, self/unknown skipped. Hermes has `fallback_providers`; this is the pure resolver for ours. The
// daemon iterates this on a failed/timed-out turn (the live mid-session swap is the daemon's integration step). Pure.
function chain(list, id) {
  const primary = find(list, id); if (!primary) return [];
  const out = [primary]; const seen = new Set([primary.id]);
  for (const fid of (primary.fallbacks || [])) {
    if (seen.has(slugify(fid))) continue;
    const f = find(list, fid); if (!f) continue;
    seen.add(f.id); out.push(f);
  }
  return out;
}

// which secret (if any) the user must supply to switch to this provider.
function secretNeeded(entry) { return (entry && entry.authKind === 'key') ? { env: entry.authEnv, label: entry.authLabel } : null; }

// resolveEnv(entry, secret, override) → { clear:[vars to unset], set:{var:value} }. The ONE source of truth for
// what a provider switch changes. Throws if a required key is missing. Every emitted key is in MANAGED (drift-frozen).
function resolveEnv(entry, secret, override = {}) {
  if (!entry) throw new Error('no provider');
  const clear = MANAGED.slice();
  const set = {};
  const big = override.big || entry.big_model || '';
  const small = override.small || entry.small_model || '';
  const tiers = () => { if (big) { set.ANTHROPIC_MODEL = big; set.URFAEL_OPUS_MODEL = big; } if (small) { set.ANTHROPIC_SMALL_FAST_MODEL = small; set.URFAEL_SONNET_MODEL = small; } };
  if (entry.kind === 'bedrock') { set.CLAUDE_CODE_USE_BEDROCK = '1'; tiers(); return { clear, set }; }
  if (entry.kind === 'vertex') { set.CLAUDE_CODE_USE_VERTEX = '1'; tiers(); return { clear, set }; }
  if (entry.kind === 'anthropic' && !entry.baseUrl) {
    // the native flat-rate cloud default — clear everything, set (at most) an API key + a tier override.
    if (entry.authKind === 'key') { if (!secret) throw new Error('missing secret: ' + entry.authEnv); set[entry.authEnv === 'ANTHROPIC_AUTH_TOKEN' ? 'ANTHROPIC_API_KEY' : entry.authEnv] = secret; }
    tiers(); return { clear, set };
  }
  // openai/gemini/ollama (or anthropic with a custom baseUrl): point the brain at the endpoint
  if (entry.baseUrl) set.ANTHROPIC_BASE_URL = entry.baseUrl;
  if (entry.authKind === 'key') { if (!secret) throw new Error('missing secret: ' + entry.authEnv); set[entry.authEnv] = secret; }
  else if (entry.authKind === 'local') set.ANTHROPIC_AUTH_TOKEN = entry.localToken || 'local';   // a placeholder token local servers accept
  tiers();
  return { clear, set };
}

// mask any secret value out of a rendered string.
function redact(s, secrets = []) { let out = String(s); for (const v of secrets) if (v) out = out.split(v).join('••••'); return out; }

// the pre-switch preview — pure data; cli.js renders it. Never contains a secret value.
function preview(entry, secret) {
  const local = !!(entry && entry.baseUrl && isLoopback((() => { try { return new URL(entry.baseUrl).hostname; } catch { return ''; } })()));
  let envDelta = {}; try { envDelta = resolveEnv(entry, secret || (secretNeeded(entry) ? 'x' : ''), {}).set; } catch { envDelta = {}; }
  return {
    id: entry && entry.id, label: entry && entry.label, kind: entry && entry.kind,
    target: (entry && entry.baseUrl) || 'native Anthropic cloud (no base URL)',
    big: (entry && entry.big_model) || '(Claude alias)', small: (entry && entry.small_model) || '(Claude alias)',
    secret: secretNeeded(entry) ? secretNeeded(entry).label : null,
    proxy: entry && entry.proxy, proxyHint: (entry && entry.proxy !== 'none') ? entry.proxyHint : '',
    note: entry && entry.note, local, isDefault: !!(entry && entry.kind === 'anthropic' && !entry.baseUrl && entry.authKind === 'none'),
    verified: !!(entry && entry.verified),
    envVars: Object.keys(envDelta).filter((k) => k !== entry.authEnv && k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN'),   // shown without any secret
  };
}

module.exports = {
  registryPath, slugify, parse, load, search, find, chain, secretNeeded, resolveEnv, redact, preview,
  KINDS, AUTHS, PROXIES, MANAGED,
};
