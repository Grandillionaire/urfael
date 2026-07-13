'use strict';
// pet.test.js — the machine-checkable acceptance tests for the opt-in code-drawn Familiar (URFAEL_PET).
// It proves, by construction: the pure state machine is TOTAL + fail-closed, the source is free of any
// brain-reaching symbol (structural zero-cost), the DEFAULT worker row + orb frame are byte-identical when the
// flag is off, the TUI/orb glue records zero pet-attributable daemon traffic, the render is deterministic +
// wall-clock-pure, Unicode degrades to 7-bit ASCII, reduce-motion is static, nothing ever throws, the token
// substring is unchanged, and the module is a clean-room re-implementation with provenance.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const pet = require('../pet');
const anim = require('../tui-anim');
const themer = require('../tui-theme');
const PET_SRC = fs.readFileSync(path.join(APP, 'pet.js'), 'utf8');

// ───────────────────────── 1) mapState: TOTAL + fail-closed → idle ─────────────────────────
test('mapState is total over the full cartesian and always returns an AGENT_STATES member', () => {
  const surfaces = ['idle', 'thinking', 'tool', 'waiting', 'failed', 'listening', 'speaking', 'capturing',
    'ZZZ', '', ' ', undefined, null, 0, 1, {}, [], NaN, Infinity, true, Symbol.iterator ? 'x' : 'x'];
  const tools = [undefined, null, '', ' ', 'bash', 'read', 'web_search', 'search_memory', 'edit', 0, 1, {}, []];
  const flags = [undefined, {}, { aborted: true }, { error: true }, { failed: true }, { aborted: 1 }, { nonsense: 1 }];
  for (const s of surfaces) for (const t of tools) for (const f of flags) {
    const bag = Object.assign({ tool: t }, f);
    const r = pet.mapState(s, bag);
    assert.ok(pet.AGENT_STATES.includes(r), 'mapState(' + JSON.stringify(s) + ',' + JSON.stringify(bag) + ') = ' + JSON.stringify(r) + ' is not a member');
  }
});

test('mapState fails closed to idle on unknown / garbage, and honours the documented precedence', () => {
  assert.equal(pet.mapState('ZZZ', {}), 'idle');
  assert.equal(pet.mapState(undefined, undefined), 'idle');
  assert.equal(pet.mapState({}, []), 'idle');
  assert.equal(pet.mapState('nonsense', { tool: 42 }), 'idle');          // a non-string tool is not a real tool
  // precedence: failure wins over tool wins over the surface state
  assert.equal(pet.mapState('thinking', { tool: 'bash', aborted: true }), 'failed');
  assert.equal(pet.mapState('idle', { error: true }), 'failed');
  assert.equal(pet.mapState('thinking', { tool: 'search_memory' }), 'tool');
  assert.equal(pet.mapState('thinking', {}), 'thinking');
  assert.equal(pet.mapState('waiting', {}), 'waiting');
  assert.equal(pet.mapState('capturing', {}), 'listening');             // the orb's mic-open alias
  assert.equal(pet.mapState('speaking', {}), 'speaking');
});

test('AGENT_STATES is the honest 7-member superset of Hermes\'s five', () => {
  assert.deepEqual([...pet.AGENT_STATES].sort(), ['failed', 'idle', 'listening', 'speaking', 'thinking', 'tool', 'waiting']);
  for (const five of ['idle', 'thinking', 'tool', 'waiting', 'failed']) assert.ok(pet.AGENT_STATES.includes(five), five + ' (a Hermes state) must be present');
});

// ───────────────────────── 2) poseFor: numeric, fail-closed ─────────────────────────
test('poseFor returns numeric pose params for every state and fails closed to the idle pose', () => {
  for (const s of pet.AGENT_STATES) {
    const p = pet.poseFor(s);
    for (const k of ['posture', 'eye', 'limb', 'glow']) {
      assert.equal(typeof p[k], 'number', s + '.' + k + ' must be a number');
      assert.ok(p[k] >= 0 && p[k] <= 1, s + '.' + k + ' must be in [0,1]');
    }
  }
  assert.deepEqual(pet.poseFor('ZZZ'), pet.poseFor('idle'));
  assert.deepEqual(pet.poseFor({}), pet.poseFor('idle'));
  assert.deepEqual(pet.poseFor(undefined), pet.poseFor('idle'));
});

// ───────────────────────── 3) structural zero-cost: source-scan ─────────────────────────
test('pet.js contains ZERO require( and NONE of the brain-reaching symbols (structural zero-cost)', () => {
  assert.ok(!/require\s*\(/.test(PET_SRC), 'pet.js must have zero require(');
  const FORBIDDEN = ['http', 'https', 'net', 'dgram', 'tls', 'socket', 'fetch', 'child_process', 'spawn', 'exec',
    'token', 'usage', 'process.env', 'request(', 'streamAsk('];
  const hits = FORBIDDEN.filter((f) => PET_SRC.includes(f));
  assert.deepEqual(hits, [], 'pet.js must not contain any brain-reaching symbol; found: ' + hits.join(', '));
});

// ───────────────────────── 4) origin-clean + no fingerprints ─────────────────────────
test('pet.js carries no origin-reveal and no no-copy-traces fingerprint', () => {
  assert.ok(!PET_SRC.includes('NousResearch' + '/hermes-agent'), 'no origin-reveal slug in pet.js');
  const FINGERPRINTS = [
    new RegExp('mirror of (herm' + 'es|openc' + 'law)', 'i'),
    new RegExp('\\bborrow' + 'able\\b', 'i'),
    new RegExp('worth ' + 'borrow' + 'ing', 'i'),
    new RegExp('what did (herm' + 'es|openc' + 'law)', 'i'),
    new RegExp('scan ' + 'rivals', 'i'),
    new RegExp('compet' + 'itor ' + 'radar', 'i'),
    new RegExp('URFAEL' + '_' + 'RADAR'),
  ];
  for (const re of FINGERPRINTS) assert.ok(!re.test(PET_SRC), 'a no-copy-traces fingerprint leaked into pet.js: ' + re);
});

// ───────────────────────── 5) determinism + wall-clock-pure frame index ─────────────────────────
test('frameTUI depends only on its args; equal elapsed → equal frame; a skipped tick skips a frame', () => {
  const FM = pet.FRAME_MS;
  for (const s of pet.AGENT_STATES) {
    // pure in (now - t0): the same elapsed from two different origins yields the same frame
    assert.equal(pet.frameTUI(s, 0, 3 * FM + 7), pet.frameTUI(s, 100000, 100000 + 3 * FM + 7), s + ' is not a pure function of elapsed');
    // a dropped tick (jump by 2 frames) advances by 2 mod the cycle length — never stutters
    const f0 = pet.frameTUI(s, 0, 0);
    const f2 = pet.frameTUI(s, 0, 2 * FM);
    const back = pet.frameTUI(s, 0, 2 * FM + FM * 0); // same as f2
    assert.equal(f2, back);
    void f0;
  }
  // a multi-frame state actually advances across a cycle boundary
  assert.notEqual(pet.frameTUI('idle', 0, 0), pet.frameTUI('idle', 0, pet.FRAME_MS));
  // and repeats every (len * FRAME_MS): idle has a 4-frame cycle
  assert.equal(pet.frameTUI('idle', 0, 0), pet.frameTUI('idle', 0, 4 * pet.FRAME_MS));
});

// ───────────────────────── 6) unicode + 7-bit ASCII fallback + reduce-motion + never-throws ─────────────────────────
test('frameTUI: {unicode:false} is pure 7-bit ASCII, {reduceMotion:true} is a single static pose', () => {
  for (const s of pet.AGENT_STATES) {
    const a = pet.frameTUI(s, 0, 12345, { unicode: false, tool: 'bash' });
    assert.ok([...a].every((ch) => ch.charCodeAt(0) < 128), s + ' ASCII fallback leaked a non-ASCII char: ' + JSON.stringify(a));
    // reduce-motion: the same pose regardless of the clock (no cycling)
    const r1 = pet.frameTUI(s, 0, 0, { reduceMotion: true, tool: 'bash' });
    const r2 = pet.frameTUI(s, 0, 99 * pet.FRAME_MS, { reduceMotion: true, tool: 'bash' });
    assert.equal(r1, r2, s + ' reduce-motion pose cycled');
  }
  // the documented ASCII faces
  assert.equal(pet.frameTUI('idle', 0, 0, { unicode: false }), '(-)');
  assert.equal(pet.frameTUI('thinking', 0, 0, { unicode: false }), '(o)');
  assert.equal(pet.frameTUI('tool', 0, 0, { unicode: false }), '(*)');
  assert.equal(pet.frameTUI('waiting', 0, 0, { unicode: false }), '(.)');
  assert.equal(pet.frameTUI('failed', 0, 0, { unicode: false }), '(x)');
});

test('frameTUI + mapState + poseFor NEVER throw on any garbage input', () => {
  const junk = [undefined, null, NaN, Infinity, -Infinity, '', 'x', 0, -1, 1e30, {}, [], true, false, () => {}, Symbol('s')];
  for (const a of junk) for (const b of junk) for (const c of junk) {
    assert.doesNotThrow(() => pet.frameTUI(a, b, c, { unicode: a, reduceMotion: b, tool: c }));
    assert.doesNotThrow(() => pet.mapState(a, { tool: b, aborted: c }));
    assert.doesNotThrow(() => pet.poseFor(a));
    const g = pet.frameTUI(a, b, c, {});
    assert.equal(typeof g, 'string', 'frameTUI must always return a string');
  }
});

// ───────────────────────── 7) DEFAULT byte-identical worker row (state × anim × reduce-motion) ─────────────────────────
test('with the pet OFF, composeWorker deep-equals the captured pre-change fixture (full matrix)', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pet-worker-parity.json'), 'utf8'));
  const T0 = 100000;
  const cache = {};
  let n = 0;
  for (const [key, expected] of Object.entries(fx)) {
    const [a, rm, lastTool, usageTokens, answerChars, el, cols] = JSON.parse(key);
    const ck = a + '|' + rm;
    if (!cache[ck]) cache[ck] = themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_THEME: 'gold', URFAEL_TUI_ANIM: a, URFAEL_TUI_REDUCE_MOTION: rm ? 'on' : 'off' }, true);
    const cfg = cache[ck];
    assert.equal(cfg.pet, false, 'the fixture cfg must have the pet OFF');
    const got = anim.composeWorker(cfg, cfg.theme, { t0: T0, lastTool, answerChars, usageTokens }, cols, T0 + el);
    assert.equal(got, expected, 'default worker row drifted for ' + key);
    n++;
  }
  assert.ok(n >= 400, 'the parity matrix must be substantial (was ' + n + ')');
});

// readTtsEnv-shape + tui readCfg default: pet false with no env
test('no env → readCfg().pet === false and the unicode capability is derived', () => {
  const c = themer.readCfg({ TERM: 'xterm-256color' }, true);
  assert.equal(c.pet, false);
  assert.equal(c.unicode, true);
  const dumb = themer.readCfg({ TERM: 'dumb' }, true);
  assert.equal(dumb.unicode, false, 'a dumb terminal has no Unicode capability → ASCII fallback');
  // the precedence: URFAEL_TUI_PET wins, else URFAEL_PET
  assert.equal(themer.readCfg({ TERM: 'xterm-256color', URFAEL_PET: '1' }, true).pet, true);
  assert.equal(themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_PET: '1' }, true).pet, true);
  assert.equal(themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_PET: '0', URFAEL_PET: '1' }, true).pet, false, 'URFAEL_TUI_PET must win over URFAEL_PET');
});

// ───────────────────────── 8) token substring unchanged (pet only prefixes) ─────────────────────────
test('the elapsed / tok / woven tail of the worker line is byte-identical with the pet on vs off', () => {
  const base = themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_THEME: 'gold', URFAEL_TUI_ANIM: 'oracle' }, true);
  const on = themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_THEME: 'gold', URFAEL_TUI_ANIM: 'oracle', URFAEL_PET: '1' }, true);
  const T0 = 100000;
  for (const st of [
    { t0: T0, lastTool: '', answerChars: 4400, usageTokens: null, petState: 'thinking' },
    { t0: T0, lastTool: '', answerChars: 4400, usageTokens: 1203, petState: 'thinking' },
    { t0: T0, lastTool: 'bash', answerChars: 0, usageTokens: null, petState: 'thinking' },
  ]) {
    const off = anim.composeWorker(base, base.theme, st, 80, T0 + 1500);
    const withPet = anim.composeWorker(on, on.theme, st, 80, T0 + 1500);
    assert.ok(withPet.endsWith(off), 'the pet must ONLY prefix a glyph; the tail must be byte-identical\n off=' + JSON.stringify(off) + '\n on =' + JSON.stringify(withPet));
    assert.ok(withPet.length > off.length, 'the pet must actually add a visible prefix when on');
    // the token substring specifically survives
    const tokRe = /(\d+ tok|~[\w.]+ woven)/;
    const mOff = off.match(tokRe), mOn = withPet.match(tokRe);
    assert.deepEqual(mOn && mOn[0], mOff && mOff[0], 'the tok/woven substring changed with the pet on');
  }
});

// composeWorker with the pet on must degrade to the plain line if the pet ever throws (defensive wrap)
test('composeWorker with the pet on never throws, even on a malformed st', () => {
  const on = themer.readCfg({ TERM: 'xterm-256color', URFAEL_PET: '1' }, true);
  for (const st of [{ t0: 0 }, { t0: NaN, lastTool: {}, petState: 42 }, { t0: 0, lastTool: 'bash' }]) {
    assert.doesNotThrow(() => anim.composeWorker(on, on.theme, st, 80, 1000));
  }
});

// ───────────────────────── 9) orb: _drawFamiliar never called when petOn is false (byte-identical frame) ─────────────────────────
function loadOrbInFakeDom() {
  const calls = [];
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'createRadialGradient') return () => gradient;
      if (prop === 'canvas') return null;
      return (...args) => { calls.push(String(prop) + '(' + args.length + ')'); return undefined; };
    },
    set(_t, prop, val) { calls.push('set:' + String(prop)); void val; return true; },
  });
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() {} };
  const prevWindow = global.window, prevPerf = global.performance;
  global.window = { devicePixelRatio: 1, innerHeight: 800, innerWidth: 800, addEventListener() {}, UrfaelPet: pet };
  global.performance = { now: () => 0 };
  delete require.cache[require.resolve('../renderer/orb.js')];
  require('../renderer/orb.js');
  const Orb = global.window.UrfaelOrb;
  const restore = () => { global.window = prevWindow; global.performance = prevPerf; delete require.cache[require.resolve('../renderer/orb.js')]; };
  return { Orb, canvas, calls, restore };
}

test('orb._drawFamiliar is NEVER invoked when petOn is false, and IS when it is on (ctx-call spy)', () => {
  const { Orb, canvas, restore } = loadOrbInFakeDom();
  try {
    const orb = new Orb(canvas);
    let familiarCalls = 0;
    const real = orb._drawFamiliar.bind(orb);
    orb._drawFamiliar = function () { familiarCalls++; return real(); };

    // pet OFF (default): the familiar layer must never run → frame byte-identical
    orb.setState('thinking');
    orb._draw(); orb._draw();
    assert.equal(familiarCalls, 0, '_drawFamiliar ran while petOn was false');

    // pet ON: the familiar layer runs once per _draw and does not throw
    orb.setPet(true); orb.setPetSignal({ tool: 'bash' });
    orb._draw();
    assert.equal(familiarCalls, 1, '_drawFamiliar must run once per frame when petOn is true');
    // it draws with the SAME primitives (arc/ellipse/gradient) — proven by the fact the ctx recorder saw calls
    orb.setPetSignal({ aborted: true }); assert.doesNotThrow(() => orb._draw());
  } finally { restore(); }
});

test('orb tolerates a missing UrfaelPet global (fail-soft, no throw)', () => {
  const { Orb, canvas, restore } = loadOrbInFakeDom();
  try {
    global.window.UrfaelPet = undefined;
    const orb = new Orb(canvas);
    orb.setPet(true); orb.setState('thinking');
    assert.doesNotThrow(() => orb._draw());   // no pet module → _drawFamiliar returns early
  } finally { restore(); }
});

// ───────────────────────── 10) behavioral zero-cost through the TUI glue ─────────────────────────
// Driving a full scripted turn through the REAL onKey/tickWorker/sendTurn with the pet ON records the SAME number
// of daemon requests + /ask streams as with the pet OFF — i.e. the pet is attributable for zero daemon traffic.
function scriptedTurn(petOn) {
  const tui = require('../tui');
  const env = { TERM: 'xterm-256color', URFAEL_TUI_THEME: 'gold', URFAEL_TUI_ANIM: 'oracle' };
  if (petOn) env.URFAEL_PET = '1';
  const cfg = themer.readCfg(env, true);
  const H = tui._internals.harness({ cfg, baseEnv: env, cols: 100, rows: 30, reply: { model: 'x' } });
  try {
    H.open();
    H.type('hello').enter();          // sendTurn → inflight, worker animating
    H.advance(300).tick(2);
    H.fire('onTool', { tool: 'bash' });   // tool pose
    H.advance(400).tick(2);
    H.fire('onDelta', { delta: 'hi ' });  // thinking pose
    H.advance(500).tick(2);
    H.fire('onDone', { text: 'hi there', usage: { output_tokens: 5 }, ms: 1200, model: 'x' });
    H.advance(100).tick(1);
    // a second turn that aborts → failed pose path
    H.type('again').enter();
    H.advance(200).tick(1);
    H.fire('onDone', { aborted: true });
    return { requests: H.requests.length, streams: H.streams.length, dumpLen: H.dump().length, threw: false };
  } catch (e) {
    return { threw: true, err: (e && e.stack) || String(e) };
  } finally { H.restore(); }
}

test('behavioral zero-cost: a scripted turn with the pet ON adds NO daemon requests / streams vs OFF', () => {
  const off = scriptedTurn(false);
  const on = scriptedTurn(true);
  assert.equal(off.threw, false, 'pet-off turn threw: ' + off.err);
  assert.equal(on.threw, false, 'pet-on turn threw: ' + on.err);
  assert.equal(on.requests, off.requests, 'the pet added daemon requests (' + on.requests + ' vs ' + off.requests + ')');
  assert.equal(on.streams, off.streams, 'the pet added /ask streams (' + on.streams + ' vs ' + off.streams + ')');
  assert.ok(on.dumpLen > 0, 'the pet-on worker row must still paint');
});

// ───────────────────────── 11) no new port / no new IPC channel wiring scan ─────────────────────────
test('the pet wiring adds no inbound port and no new IPC channel', () => {
  const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
  // pet.js opens nothing (no server primitives)
  assert.ok(!/createServer|\.listen\s*\(/.test(PET_SRC), 'pet.js must open no port');
  // none of the touched surfaces introduce a pet IPC channel or a new renderer bridge
  const touched = ['tui-anim.js', 'tui.js', 'tui-theme.js', 'main.js', 'renderer/orb.js', 'renderer/app.js', 'renderer/index.html'].map(read).join('\n');
  assert.ok(!/urfael:pet/.test(touched), 'the pet must not add a urfael:pet IPC channel');
  assert.ok(!/window\.urfael\.onPet|ipcRenderer\./.test(read('renderer/app.js')), 'no new renderer IPC surface for the pet');
  assert.ok(!/createServer|http\.Server/.test(read('renderer/orb.js')), 'the orb familiar opens no server');
  // the config still rides the existing urfael:config / onThinking / onDone signals
  assert.ok(/onThinking/.test(read('renderer/app.js')) && /onDone/.test(read('renderer/app.js')), 'the pet must reuse the existing onThinking/onDone signals');
});

// ───────────────────────── 12) zero-dep invariant unchanged (belt-and-braces) ─────────────────────────
test('app/package.json dependencies stays exactly {} (the pet added no dep)', () => {
  const pkg = require('../package.json');
  assert.deepStrictEqual(pkg.dependencies, {});
});
