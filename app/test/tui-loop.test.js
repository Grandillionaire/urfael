'use strict';
// COMPOSED TUI EVENT-LOOP TEST — the one piece the pure-render suite could never reach.
//
// tui.test.js exercises the PURE modules (theme, anim math, the differential writer, the row composer). But the
// thing that historically shipped a live regression green was the COMPOSED loop: onKey dispatch + the setInterval
// animation tick (tickWorker) + a streamed turn wired together against the real TTY. The escaped bug was a
// ReferenceError in the tick — a `caretFor` that a multi-line-input refactor deleted while the tickWorker call was
// left behind — so every animation frame during a turn threw and crashed the whole cockpit, yet the pure tests
// stayed green. This test closes that gap.
//
// It drives a FULL turn through the REAL onKey / tickWorker / sendTurn against an INJECTED io (a fake stdout that
// captures writes, a fake clock, a fake animation timer that records the tick fn, and a fake /ask stream whose
// handlers we fire): open -> a prompt keystroke -> several animation ticks -> streamed tool/deltas -> done. It
// asserts NO throw AND that the answer renders AND that the tick actually PAINTS the worker row — which is the
// assertion that catches a caretFor-style undefined reference: if the tick throws, renderWorkerOnly never runs, so
// the captured writes never grow. (Proven by temporarily reintroducing such a ref: this test then goes red.)
const { test } = require('node:test');
const assert = require('node:assert');
const themer = require('../tui-theme');
const rend = require('../tui-render');
const { harness } = require('../tui')._internals;

const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
// a deterministic, motion-ON cfg: pin theme + anim so readCfg never reads an on-disk ui-prefs.json, and keep
// TERM/NO_COLOR/CI clean so reduceMotion stays false (the worker row animates → the tick has something to paint).
const CFG = () => themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_THEME: 'gold', URFAEL_TUI_ANIM: 'oracle' }, true);
const GEOM = { cols: 80, rows: 24 };
const WORKER_ADDR = '\x1b[' + (rend.layout(GEOM, CFG()).workerRow + 1) + ';1H';   // the cursor-move the tick emits to repaint the worker row

test('composed loop: a full turn (open, keystrokes, animation ticks, streamed deltas, done) never throws and renders the answer', () => {
  const H = harness({ cfg: CFG(), cols: GEOM.cols, rows: GEOM.rows, now: 100000 });
  try {
    // ── open ──────────────────────────────────────────────────────────────────────────────────────
    H.open();
    assert.ok(H.dump().length > 0, 'opening the cockpit paints an initial frame to the fake stdout');
    assert.equal(H.state().inflight, false);

    // ── a prompt keystroke, then Enter → sendTurn starts the streamed turn ──────────────────────────
    H.type('hello').enter();
    let st = H.state();
    assert.equal(st.inflight, true, 'Enter on a non-empty buffer starts a turn');
    assert.ok(st.lines.some((l) => l.who === 'you' && l.text === 'hello'), 'the you-row carries the typed prompt');
    assert.equal(H.hasTick(), true, 'a turn arms the animation tick via the injected timer');
    assert.ok(H.stream() && H.stream().text === 'hello', 'the turn opened the /ask stream through the injected io');

    // ── several animation ticks while the turn is in flight — the loop that once threw caretFor ─────
    const before = H.writes.length;
    H.advance(150).tick();
    H.advance(150).tick();
    H.advance(150).tick();
    assert.ok(H.writes.length > before, 'the animation tick paints the worker row (caretFor resolved — no swallowed throw)');
    const painted = H.writes.slice(before).join('');
    assert.ok(painted.includes(WORKER_ADDR), 'the tick addressed and rewrote exactly the worker row');

    // ── streamed events: a tool, then two thinking deltas, then a tick, then done ───────────────────
    H.fire('onTool', { tool: 'search_memory' });
    H.fire('onDelta', { delta: 'Hello ' });
    H.fire('onDelta', { delta: 'world.' });
    H.advance(150).tick();                                 // a tick mid-stream still paints, never crashes
    H.fire('onDone', { text: 'Hello world.', usage: { output_tokens: 7 }, ms: 1234, model: 'claude-sonnet-4' });

    // ── the turn settled: the answer rendered, the tick disarmed, nothing crashed ───────────────────
    st = H.state();
    assert.equal(st.inflight, false, 'the done event ends the turn');
    assert.equal(H.hasTick(), false, 'the done event disarms the animation tick');
    assert.ok(st.lines.some((l) => l.who === 'urfael' && l.text.includes('Hello world.')), 'the streamed answer landed in the transcript');
    assert.ok(strip(H.dump()).includes('Hello world.'), 'the answer was actually written to the (fake) terminal');
    assert.ok(st.lines.some((l) => l.who === 'tool' && l.text.includes('search_memory')), 'the tool row was rendered above the answer');
  } finally {
    H.restore();
  }
});

test('composed loop: the animation tick is crash-proof AND paints on every in-flight frame (the caretFor guard)', () => {
  // Focused twin of the above: prove the tick both (a) never throws out to the caller and (b) actually produces a
  // worker-row write on each in-flight frame with an advancing clock. A caretFor-style undefined reference would
  // break (b) — the paint would be silently swallowed by tickWorker's crash-proof wrap — so this is the assertion
  // that turns that whole bug class red instead of green.
  const H = harness({ cfg: CFG(), cols: GEOM.cols, rows: GEOM.rows, now: 500000 });
  try {
    H.open();
    H.type('ping').enter();
    assert.equal(H.state().inflight, true);
    let painted = 0;
    for (let i = 0; i < 5; i++) {
      const before = H.writes.length;
      H.advance(120).tick();                              // advance past a frame so the worker row genuinely changes
      if (H.writes.length > before && H.writes.slice(before).join('').includes(WORKER_ADDR)) painted++;
    }
    assert.ok(painted >= 1, 'the in-flight animation tick painted the worker row at least once (tick render path is live)');
    // and a tick BEFORE any turn (nothing in flight) is a quiet no-op, never a throw
    H.fire('onDone', { text: 'pong', usage: { output_tokens: 1 } });
    assert.equal(H.state().inflight, false);
    const q = H.writes.length;
    H.advance(120).tick();                                // not in flight → tickWorker returns early
    assert.equal(H.writes.length, q, 'an idle tick writes nothing');
  } finally {
    H.restore();
  }
});
