'use strict';
// Unit tests for ui-palette.js — pure logic, Node stdlib only, NO daemon required. Prefs I/O is exercised
// against a throwaway temp dir so nothing touches the real ~/.claude/urfael state.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ui = require('../ui-palette');

// ---- THEMES shape -------------------------------------------------------------------------------------------
test('THEMES carries every named palette with the full token set', () => {
  for (const name of ui.THEME_NAMES) {
    assert.ok(ui.THEMES[name], 'missing theme ' + name);
    for (const key of ui.TOKEN_KEYS) {
      assert.strictEqual(typeof ui.THEMES[name][key], 'string', name + '.' + key + ' must be a string');
      assert.ok(ui.isSafeColor(ui.THEMES[name][key]), name + '.' + key + ' must be a safe color: ' + ui.THEMES[name][key]);
    }
  }
  assert.deepStrictEqual([...ui.THEME_NAMES].sort(), ['custom', 'ember', 'gold', 'matrix', 'mono', 'nord', 'ocean', 'rose', 'sand', 'violet']);
});

test('custom slot defaults to the gold identity (no-customization == current look)', () => {
  assert.deepStrictEqual(ui.THEMES.custom, ui.THEMES.gold);
});

// ---- isSafeColor: the allowlist -----------------------------------------------------------------------------
test('isSafeColor accepts hex / rgb / hsl / oklch / safe-named', () => {
  for (const ok of ['#fff', '#ffff', '#d8a23a', '#d8a23aff', 'rgb(12,34,56)', 'rgba(1,2,3,0.5)',
    'hsl(40,80%,50%)', 'hsla(40,80%,50%,.4)', 'oklch(0.7 0.1 80)', 'oklab(0.6 0.1 0.1)',
    'gold', 'GOLD', 'transparent', 'currentColor']) {
    assert.strictEqual(ui.isSafeColor(ok), true, 'should accept ' + ok);
  }
});

test('isSafeColor REJECTS every injection vector', () => {
  for (const bad of [
    'url(http://evil)', "url('x.png')", 'image(x)', '@import "x"', 'expression(alert(1))',
    'javascript:alert(1)', 'red;background:url(x)', 'red}body{display:none', '#fff;}', 'red /* c */',
    'rgb(1,2,3) url(x)', 'red\nbackground:blue', 'red\t;x', 'notacolor', '', '   ', null, undefined, 42, {},
    '#gggggg', '<script>', 'rgb(1,2,3);', "expression\\28 ", 'red blue',
  ]) {
    assert.strictEqual(ui.isSafeColor(bad), false, 'should reject ' + JSON.stringify(bad));
  }
});

// ---- sanitizeCustomTheme ------------------------------------------------------------------------------------
test('sanitizeCustomTheme accepts a partial palette and fills gaps from gold', () => {
  const r = ui.sanitizeCustomTheme({ gold: '#112233', accent: 'rgb(10,20,30)' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.palette.gold, '#112233');
  assert.strictEqual(r.palette.accent, 'rgb(10,20,30)');
  assert.strictEqual(r.palette.bg, ui.THEMES.gold.bg, 'unset tokens fall back to gold');
  for (const key of ui.TOKEN_KEYS) assert.ok(key in r.palette, 'palette must be complete: ' + key);
});

test('sanitizeCustomTheme rejects when ANY token is unsafe', () => {
  const r = ui.sanitizeCustomTheme({ gold: '#112233', bg: 'url(http://evil)' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bg/);
});

test('sanitizeCustomTheme rejects non-objects and ignores unknown keys', () => {
  assert.strictEqual(ui.sanitizeCustomTheme(null).ok, false);
  assert.strictEqual(ui.sanitizeCustomTheme('red').ok, false);
  assert.strictEqual(ui.sanitizeCustomTheme(['#fff']).ok, false);
  const r = ui.sanitizeCustomTheme({ gold: '#112233', NOT_A_TOKEN: 'url(x)', '--evil': 'expression()' });
  assert.strictEqual(r.ok, true, 'unknown keys are ignored, not rejected');
  assert.ok(!('NOT_A_TOKEN' in r.palette));
});

// ---- toCssVars ----------------------------------------------------------------------------------------------
test('toCssVars emits a :root block with the expected vars + aliases', () => {
  const css = ui.toCssVars(ui.THEMES.gold);
  assert.match(css, /^:root\{/);
  assert.match(css, /\}$/);
  assert.match(css, /--gold:#d8a23a/);
  assert.match(css, /--bg:#0c0b09/);
  assert.match(css, /--accent:#f0c768/);
  assert.match(css, /--ink:#ece6d8/, 'aliases body -> --ink for dashboard.js');
  assert.match(css, /--gold2:#f0c768/, 'aliases accent -> --gold2 for dashboard.js');
});

test('toCssVars never emits an unsafe value even from a hand-built palette', () => {
  const css = ui.toCssVars({ bg: 'url(http://evil)', gold: '#abcdef' });
  assert.ok(!css.includes('url('), 'unsafe token dropped');
  assert.match(css, /--gold:#abcdef/, 'safe token kept');
});

// ---- resolvePalette -----------------------------------------------------------------------------------------
test('resolvePalette honors named theme, custom overlay, and accent override', () => {
  assert.deepStrictEqual({ ...ui.resolvePalette({ theme: 'ember' }) }, { ...ui.THEMES.ember });
  // unknown theme -> gold
  assert.deepStrictEqual({ ...ui.resolvePalette({ theme: 'nope' }) }, { ...ui.THEMES.gold });
  // accent override on a base theme
  const a = ui.resolvePalette({ theme: 'mono', accent: '#ff0000' });
  assert.strictEqual(a.accent, '#ff0000');
  assert.strictEqual(a.bg, ui.THEMES.mono.bg);
  // unsafe accent ignored
  const b = ui.resolvePalette({ theme: 'mono', accent: 'url(x)' });
  assert.strictEqual(b.accent, ui.THEMES.mono.accent);
  // custom overlay
  const c = ui.resolvePalette({ theme: 'custom', custom: { gold: '#101010' } });
  assert.strictEqual(c.gold, '#101010');
});

// ---- normalizePrefs: the closed schema ----------------------------------------------------------------------
test('normalizePrefs drops every key outside {theme,animation,accent,character}', () => {
  const out = ui.normalizePrefs({
    theme: 'ember', animation: 'rune', accent: '#abc', character: 'Hermes',
    // adversarial extras that MUST NOT survive:
    URFAEL_YOLO: '1', bypassPermissions: true, apiKey: 'sk-xxx', permissionMode: 'bypassPermissions',
    deny: ['rm'], token: 'secret',
  });
  assert.deepStrictEqual(Object.keys(out).sort(), ['accent', 'animation', 'character', 'theme']);
  assert.strictEqual(out.theme, 'ember');
  assert.strictEqual(out.animation, 'rune');
  assert.strictEqual(out.accent, '#abc');
  assert.strictEqual(out.character, 'hermes');
  assert.ok(!('URFAEL_YOLO' in out));
  assert.ok(!('bypassPermissions' in out));
  assert.ok(!('apiKey' in out));
  assert.ok(!('permissionMode' in out));
});

test('normalizePrefs fails soft on garbage -> defaults; unsafe accent stripped', () => {
  assert.deepStrictEqual(ui.normalizePrefs(null), { ...ui.DEFAULT_PREFS });
  assert.deepStrictEqual(ui.normalizePrefs('x'), { ...ui.DEFAULT_PREFS });
  const out = ui.normalizePrefs({ theme: 'bogus', animation: 'bogus', accent: 'url(x)', character: 'no spaces!' });
  assert.deepStrictEqual(out, { ...ui.DEFAULT_PREFS });
});

// ---- loadPrefs / savePrefs round-trip + atomicity + 0600 ----------------------------------------------------
test('loadPrefs returns defaults when the file is missing or corrupt (never throws)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-ui-'));
  const missing = path.join(dir, 'nope', 'ui-prefs.json');
  assert.deepStrictEqual(ui.loadPrefs(missing), { ...ui.DEFAULT_PREFS });
  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ not json ');
  assert.deepStrictEqual(ui.loadPrefs(corrupt), { ...ui.DEFAULT_PREFS });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('savePrefs writes 0600 atomically and round-trips through loadPrefs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-ui-'));
  const fp = path.join(dir, 'sub', 'ui-prefs.json');
  const r = ui.savePrefs(fp, { theme: 'mono', animation: 'scry', accent: 'oklch(0.7 0.1 80)', character: 'urfael', extra: 'nope' });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(fp), 'file written');
  const mode = fs.statSync(fp).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'file must be owner-only, got ' + mode.toString(8));
  // no temp leftovers in the dir
  const leftovers = fs.readdirSync(path.dirname(fp)).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'no temp file left behind');
  const back = ui.loadPrefs(fp);
  assert.strictEqual(back.theme, 'mono');
  assert.strictEqual(back.animation, 'scry');
  assert.strictEqual(back.accent, 'oklch(0.7 0.1 80)');
  assert.ok(!('extra' in back));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('savePrefs fails soft (no throw) on an unwritable path', () => {
  // a path whose parent is a file, not a dir -> mkdir/write fails; must return {ok:false}, never throw.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-ui-'));
  const asFile = path.join(dir, 'afile');
  fs.writeFileSync(asFile, 'x');
  const r = ui.savePrefs(path.join(asFile, 'ui-prefs.json'), { theme: 'gold' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(typeof r.error, 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saved custom palette survives the round-trip and stays sanitized', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-ui-'));
  const fp = path.join(dir, 'ui-prefs.json');
  ui.savePrefs(fp, { theme: 'custom', custom: { gold: '#123456', bg: 'url(evil)' } });
  const back = ui.loadPrefs(fp);
  // the unsafe bg token made the WHOLE custom map invalid -> it is dropped, not partially trusted
  assert.ok(!('custom' in back) || back.custom.bg !== 'url(evil)');
  fs.rmSync(dir, { recursive: true, force: true });
});
