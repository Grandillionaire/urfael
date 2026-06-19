'use strict';
// fuzz.js — input-boundary fuzz/property harness over the REAL pure parsers, normalizers, and renderers.
//   npm run fuzz            (seeded random + a frozen crash corpus replayed first)
//   URFAEL_FUZZ_SEED=N FUZZ_ITERS=N FUZZ_BUDGET_MS=N npm run fuzz   (reproduce / tune)
// Pure Node, zero deps. Four oracles per call: (1) never throws unhandled, (2) bounded TIME — the ReDoS
// detector that caught skillhub.scan's quadratic long-line case, (3) bounded OUTPUT, (4) fail-closed SHAPE
// (a normalizer must return null-or-valid; a guard must stay safe; a sandbox must never reach 'local').
// A finding prints a replay seed + the minimized input; freeze it in fuzz-corpus.json so it can't come back.
const fs = require('fs');
const path = require('path');
const lib = require('../lib');
const md = require('../md');
const hub = require('../skillhub');
const chain = require('../audit-chain');
const seal = require('../seal');
const council = require('../council');
const personas = require('../personas');
const connectors = require('../connectors');
const pluginhub = require('../pluginhub');
const providers = require('../providers');

const ITERS = parseInt(process.env.FUZZ_ITERS || '20000', 10);
const BUDGET_MS = parseInt(process.env.FUZZ_BUDGET_MS || '250', 10);   // a parser must be ~linear; > this = ReDoS suspect
const OUT_CAP = 4 * 1024 * 1024;                                       // a string result above this = bounded-output violation
const CORPUS = path.join(__dirname, 'fuzz-corpus.json');

// ---- seeded xorshift32 so any failure replays from its seed --------------------------------------------
let SEED = (parseInt(process.env.URFAEL_FUZZ_SEED || '', 10) || (Date.now() & 0x7fffffff)) >>> 0;
const startSeed = SEED;
function rnd() { SEED ^= SEED << 13; SEED ^= SEED >>> 17; SEED ^= SEED << 5; SEED >>>= 0; return SEED / 0x100000000; }
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];

// ---- generators: heavy on the bytes + shapes that break parsers ----------------------------------------
const CHARS = ['a', '0', ' ', '\n', '\t', '*', '_', '`', '#', '-', '|', '>', ':', '/', '\\', '.', ',', '@', '$',
  '{', '}', '[', ']', '(', ')', '"', "'", '\x00', '\x01', '\x1b', '﻿', '​', '‮', '世', '🌍'];
const PREFIXES = ['', 'curl http://', '**', '_', '`', '## ', '- ', 'POST https://x ', '0 0 * * *', 'rm -rf ', 'http://2130706433/', '::ffff:127.0.0.1'];
function fuzzStr(maxLen) {
  const n = ri(maxLen);
  if (rnd() < 0.25) return pick(PREFIXES) + pick(CHARS).repeat(n);     // long single-char runs = the ReDoS trigger
  let s = ''; for (let i = 0; i < n; i++) s += pick(CHARS); return s;
}
function fuzzVal(depth) {
  const r = rnd();
  if (depth > 3 || r < 0.3) return pick([null, undefined, true, false, 0, -1, 1e9, NaN, Infinity, '', fuzzStr(40), ri(1e6)]);
  if (r < 0.55) return fuzzStr(60);
  if (r < 0.75) { const a = []; for (let i = ri(5); i > 0; i--) a.push(fuzzVal(depth + 1)); return a; }
  const o = {}; for (let i = ri(6); i > 0; i--) o[pick(['text', 'at', 'inMins', 'repeat', 'cron', 'days', 'name', 'script', 'prompt', 'action', 'replyUrl', 'kind', 'then', 'everyMins', 'deliver', 'id', 'glyph', fuzzStr(8)])] = fuzzVal(depth + 1);
  return o;
}

// a standalone copy of the daemon's NDJSON line-splitter (Session._onData), isolated so the hot parse loop is fuzzable.
function ndjsonDrain(chunk) {
  let buf = String(chunk), i; const out = [];
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let e; try { e = JSON.parse(line); } catch { continue; } out.push(e && e.type); }
  return out;
}

const ok = true;
const isNullOrObj = (r) => (r === null || (typeof r === 'object' && !Array.isArray(r))) || 'returned non-null-non-object: ' + typeof r;
// [name, call(input), shapeOracle(result)->true|string]. The shape oracle is the fail-CLOSED check.
const targets = [
  ['lib.normalizeReminder', (v) => lib.normalizeReminder(v), isNullOrObj],
  ['lib.normalizeCron', (v) => lib.normalizeCron(v), isNullOrObj],
  ['lib.normalizeScript', (v) => lib.normalizeScript(v), isNullOrObj],
  ['lib.normalizeJobAction', (v) => lib.normalizeJobAction(v), isNullOrObj],
  ['lib.normalizeHook', (v) => lib.normalizeHook(v), (r) => r === null || (typeof r === 'object' && (typeof r.replyUrl !== 'string' || (() => { try { return lib.isPrivateHost(new URL(r.replyUrl).hostname) === false; } catch { return false; } })())) || 'normalizeHook accepted a private/garbage replyUrl: ' + (r && r.replyUrl)],
  ['lib.parseCron', (v) => lib.parseCron(typeof v === 'string' ? v : '')],
  ['lib.parseModelDirective', (v) => lib.parseModelDirective(typeof v === 'string' ? v : ''), (r) => r === null || typeof r === 'object' || 'bad directive shape'],
  ['lib.parsePersonaDirective', (v) => lib.parsePersonaDirective(typeof v === 'string' ? v : '', ['architect', 'sage'])],
  ['lib.resolveProfile', (v) => lib.resolveProfile(v), (r) => (r && typeof r.name === 'string') || 'resolveProfile returned no name'],
  ['lib.profileFor', (v) => lib.profileFor(v, pick(['fortress', 'full', v])), (r) => (r && r.name !== 'local') || 'profileFor reached LOCAL from a role/mode!'],
  ['lib.resolvePrincipal', (v) => lib.resolvePrincipal({ telegram: [{ id: '1', role: 'owner' }] }, pick(['telegram', v]), v)],
  ['lib.isPrivateHost', (v) => lib.isPrivateHost(typeof v === 'string' ? v : ''), (r) => typeof r === 'boolean' || 'isPrivateHost non-boolean'],
  ['md.toAnsi', (v) => md.toAnsi(typeof v === 'string' ? v : JSON.stringify(v), { color: true, base: '\x1b[33m' }), (r) => typeof r === 'string' || 'toAnsi non-string'],
  ['hub.scan', (v) => hub.scan(typeof v === 'string' ? v : JSON.stringify(v)), (r) => (r && Array.isArray(r.flags)) || 'scan returned no flags[]'],
  ['hub.meta', (v) => hub.meta(typeof v === 'string' ? v : '', 'fb'), (r) => (r && typeof r.name === 'string' && r.name.length <= 200 && typeof r.desc === 'string') || 'meta bad shape'],
  ['hub.slugify', (v) => hub.slugify(v), (r) => (typeof r === 'string' && /^[a-z0-9-]*$/.test(r) && r.length <= 64) || 'slugify produced an unsafe slug: ' + JSON.stringify(r)],
  ['hub.parseIndex', (v) => hub.parseIndex(typeof v === 'string' ? v : JSON.stringify(v)), (r) => (Array.isArray(r) && r.every((e) => /^[a-z0-9-]+$/.test(e.slug) && /^https:\/\//i.test(e.url))) || 'parseIndex kept an unsafe entry'],
  ['connectors.parse', (v) => connectors.parse(typeof v === 'string' ? v : JSON.stringify(v)), (r) => (Array.isArray(r) && r.every((e) => /^[a-z0-9-]+$/.test(e.id) && ((e.transport === 'npx' || e.transport === 'uvx') ? !!e.pkg : (/^https:\/\//.test(e.url) || connectors.isLoopback(new URL(e.url).hostname))) && (e.env || []).every((f) => /^[A-Z][A-Z0-9_]*$/.test(f.key)))) || 'connectors.parse kept a malformed/plaintext-remote/flag-smuggling entry'],
  ['providers.parse', (v) => providers.parse(typeof v === 'string' ? v : JSON.stringify(v)), (r) => (Array.isArray(r) && r.every((e) => /^[a-z0-9-]+$/.test(e.id) && providers.KINDS.has(e.kind) && providers.AUTHS.has(e.authKind) && (!e.baseUrl || /^https:\/\//.test(e.baseUrl) || /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/.test(e.baseUrl)))) || 'providers.parse kept a malformed/plain-http row'],
  ['pluginhub.parse', (v) => pluginhub.parse(typeof v === 'string' ? v : JSON.stringify(v)), (r) => r === null || (r && /^[a-z0-9][a-z0-9-]+$/.test(r.id) && r.activation.ownerTurnsOnly === true && Array.isArray(r.caps.fs) && r.caps.fs.every((f) => /^vault:/.test(f.path)) && r.caps.net.every((n) => /^[a-z0-9.-]+$/.test(n.host))) || 'pluginhub.parse produced an unsafe manifest (non-vault fs / bad host / not owner-only)'],
  ['pluginhub.buildCellArgs', (v) => pluginhub.buildCellArgs(pluginhub.parse(JSON.stringify({ schema: 'urfael.plugin/v1', id: 'fz', runtime: 'mcp-native', entry: { transport: 'stdio', cmd: ['node', 's.js'] } })) || { entry: { cmd: [] }, limits: {} }, typeof v === 'object' && v ? v : {}), (r) => (Array.isArray(r) && r.includes('none') && r.indexOf('--network') >= 0 && r[r.indexOf('--network') + 1] === 'none' && r.every((a) => typeof a === 'string' && !/[\n\r\0]/.test(a))) || 'buildCellArgs emitted a non-default-deny or shell-unsafe argv'],
  ['chain.verify', (v) => chain.verify(Array.isArray(v) ? v : [String(v)]), (r) => (r && typeof r.ok === 'boolean') || 'verify non-result'],
  ['seal.verify', (v) => seal.verify('not-a-key', String(v), String(v)), (r) => r === false || r === true || 'seal.verify non-boolean'],
  ['council._parsePlan', (v) => council._parsePlan(typeof v === 'string' ? v : JSON.stringify(v), 'task', 3), (r) => (r && Array.isArray(r.subtasks) && r.subtasks.length >= 1 && r.subtasks.length <= 3) || 'plan subtasks out of [1,cap]'],
  ['personas.normalizeAuthored', (v) => personas.normalizeAuthored(v), (r) => r === null || (r && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(r.id) && r.prompt.length <= 4000) || 'authored persona escaped its bounds'],
  ['ndjson.reader', (v) => ndjsonDrain(typeof v === 'string' ? v : JSON.stringify(v)), (r) => Array.isArray(r) || 'ndjson reader non-array'],
];

const fails = [];
function clip(v) { try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 200 ? s.slice(0, 200) + '…(' + s.length + ')' : s; } catch { return '<unstringifiable>'; } }
function probe(name, fn, oracle, input) {
  let out; const t0 = process.hrtime.bigint();
  try { out = fn(input); }
  catch (e) { fails.push({ name, why: 'THREW: ' + ((e && e.message) || e), seed: SEED, input: clip(input) }); return; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms > BUDGET_MS) fails.push({ name, why: 'TIME ' + ms.toFixed(0) + 'ms > ' + BUDGET_MS + 'ms (ReDoS?)', seed: SEED, input: clip(input) });
  if (typeof out === 'string' && out.length > OUT_CAP) fails.push({ name, why: 'OUTPUT ' + out.length + 'B > cap', seed: SEED, input: clip(input) });
  if (oracle) { const v = oracle(out); if (v !== true && v !== undefined) fails.push({ name, why: 'SHAPE: ' + v, seed: SEED, input: clip(input) }); }
}

// 1) replay the frozen crash corpus first — these are regressions that must stay green
let corpus = [];
try { corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8')); } catch {}
for (const c of corpus) { const t = targets.find((x) => x[0] === c.target); if (t) probe(t[0], t[1], t[2], c.input); }
if (fails.length) console.error('✗ ' + fails.length + ' FROZEN-CORPUS regression(s) re-broke');

// 2) fuzz
for (let n = 0; n < ITERS; n++) { const [name, fn, oracle] = pick(targets); probe(name, fn, oracle, rnd() < 0.5 ? fuzzStr(40000) : fuzzVal(0)); }

if (fails.length) {
  const uniq = []; const seen = new Set();
  for (const f of fails) { const k = f.name + '|' + f.why.slice(0, 30); if (!seen.has(k)) { seen.add(k); uniq.push(f); } }
  console.error('\n✗ FUZZ FAILED — ' + fails.length + ' finding(s), ' + uniq.length + ' unique (startSeed=' + startSeed + '):');
  for (const f of uniq.slice(0, 40)) console.error('  • ' + f.name + ' — ' + f.why + '  seed=' + f.seed + '  input=' + JSON.stringify(f.input));
  console.error('\nFIX the source, then FREEZE the reduced input: add {"target":"' + uniq[0].name + '","input":<reduced>} to test/fuzz-corpus.json.');
  process.exit(1);
}
console.log('✓ fuzz: ' + ITERS + ' iters × ' + targets.length + ' targets clean (startSeed=' + startSeed + ', corpus=' + corpus.length + ', budget=' + BUDGET_MS + 'ms). No throw / no ReDoS / fail-closed shape held.');
void ok;
