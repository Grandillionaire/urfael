'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const a2 = require('../a2ui');

const fence = (json) => '```a2ui\n' + json + '\n```';

// ── a valid canvas parses into safe normalized blocks ──
test('parse extracts and normalizes allowlisted blocks', () => {
  const r = a2.parse(fence(JSON.stringify({ blocks: [
    { type: 'heading', text: 'Deploy status' },
    { type: 'progress', value: 73, label: 'building' },
    { type: 'table', headers: ['svc', 'state'], rows: [['voicebot', 'up'], ['chatbot', 'up']] },
    { type: 'button', label: 'Redeploy', action: 'redeploy.voicebot' },
  ] })));
  assert.equal(r.blocks.length, 4);
  assert.equal(r.blocks[0].text, 'Deploy status');
  assert.equal(r.blocks[1].value, 73);
  assert.deepEqual(r.blocks[3], { type: 'button', label: 'Redeploy', action: 'redeploy.voicebot' });
});

// ── THE SECURITY PROPERTY: no path from agent JSON to executable code or a dangerous href ──
test('a2ui is XSS-proof by construction', () => {
  // script/html/iframe block types are not allowlisted → dropped
  assert.equal(a2.parse(fence('{"type":"script","text":"alert(1)"}')).blocks.length, 0);
  assert.equal(a2.parse(fence('{"type":"html","text":"<img onerror=alert(1)>"}')).blocks.length, 0);
  assert.equal(a2.parse(fence('{"type":"iframe","src":"evil"}')).blocks.length, 0);
  // a javascript:/data:/http link is dropped; only https survives
  assert.equal(a2.parse(fence('{"type":"link","text":"x","href":"javascript:alert(1)"}')).blocks.length, 0);
  assert.equal(a2.parse(fence('{"type":"link","text":"x","href":"data:text/html,<script>"}')).blocks.length, 0);
  assert.equal(a2.parse(fence('{"type":"link","text":"x","href":"http://insecure"}')).blocks.length, 0);
  assert.equal(a2.parse(fence('{"type":"link","text":"docs","href":"https://example.com/x"}')).blocks[0].href, 'https://example.com/x');
  // a button NEVER carries a click handler or a url: only {type,label,action(bare id)} survive; onclick is stripped
  const btn = a2.parse(fence('{"type":"button","label":"Go","action":"do.thing","onclick":"steal()","href":"javascript:1"}')).blocks[0];
  assert.deepEqual(Object.keys(btn).sort(), ['action', 'label', 'type']);
  assert.doesNotMatch(btn.action, /[()'"\s]/);
  // raw <script> in a TEXT value is preserved as literal text (the renderer shows it via textContent, never executes)
  const txt = a2.parse(fence('{"type":"text","text":"<script>alert(1)</script>"}')).blocks[0];
  assert.equal(txt.text, '<script>alert(1)</script>');
  // control chars (terminal-escape injection) are stripped
  assert.doesNotMatch(a2.parse(fence('{"type":"text","text":"a\\u001b[31mred"}')).blocks[0].text, //);
});

// ── bounds: a hostile canvas can't blow up the renderer ──
test('parse bounds block count, nesting, table size, and text length', () => {
  const many = a2.parse(fence(JSON.stringify(Array.from({ length: 200 }, () => ({ type: 'text', text: 'x' })))));
  assert.ok(many.blocks.length <= 40);
  const deep = a2.parse(fence('{"type":"card","children":[{"type":"card","children":[{"type":"card","children":[{"type":"text","text":"too deep"}]}]}]}'));
  // 3rd-level card is dropped (depth >= 2), so "too deep" never appears
  assert.doesNotMatch(JSON.stringify(deep.blocks), /too deep/);
  const wide = a2.parse(fence('{"type":"table","headers":' + JSON.stringify(Array(50).fill('h')) + ',"rows":[' + JSON.stringify(Array(50).fill('c')) + ']}')).blocks[0];
  assert.ok(wide.headers.length <= 8 && wide.rows[0].length <= 8);
  assert.ok(a2.parse(fence('{"type":"text","text":"' + 'a'.repeat(9000) + '"}')).blocks[0].text.length <= 2000);
});

// ── extract handles both delimiters; has() detects a canvas; junk is total + ReDoS-bounded ──
test('extract, has, and robustness', () => {
  assert.equal(a2.has('plain reply, no canvas'), false);
  assert.equal(a2.has('text [A2UI]{"type":"text","text":"hi"}[/A2UI] more'), true);
  assert.equal(a2.parse('text [A2UI]{"type":"badge","text":"ok","tone":"ok"}[/A2UI]').blocks[0].tone, 'ok');
  assert.doesNotThrow(() => a2.parse(null));
  assert.doesNotThrow(() => a2.parse(fence('not json {{{')));
  const t0 = process.hrtime.bigint();
  a2.parse('```a2ui ' + 'x'.repeat(100000));   // unterminated fence, pathological
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, 'extract must stay linear');
});
