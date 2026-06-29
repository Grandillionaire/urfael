'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const radar = require('../radar');

test('newReleases: first run returns just the latest, then everything newer than lastTag', () => {
  const rels = [{ tagName: 'v3' }, { tagName: 'v2' }, { tagName: 'v1' }];   // newest-first
  assert.deepEqual(radar.newReleases(rels, null).map((r) => r.tagName), ['v3']);        // first run = baseline sample
  assert.deepEqual(radar.newReleases(rels, 'v1').map((r) => r.tagName), ['v3', 'v2']);  // newer than v1
  assert.deepEqual(radar.newReleases(rels, 'v3'), []);                                  // nothing newer than the newest
  assert.deepEqual(radar.newReleases([], 'v1'), []);                                    // no releases
  assert.equal(radar.newReleases(rels, 'gone', 2).length, 2);                           // unseen tag → capped fallback
});

test('buildAnalysisPrompt embeds the principles, the repo + release, and the no-dash rule', () => {
  const p = radar.buildAnalysisPrompt('x/y', { tagName: 'v9', body: 'NEW FEATURE Z' }, 'URFAEL MAP HERE');
  assert.match(p, /NON-NEGOTIABLE PRINCIPLES/);
  assert.match(p, /x\/y v9/);
  assert.match(p, /NEW FEATURE Z/);
  assert.match(p, /URFAEL MAP HERE/);
  assert.match(p, /no em dashes or en dashes/);
});

test('assembleReport carries the human-gate framing and each item', () => {
  const md = radar.assembleReport([{ repo: 'a/b', rel: { tagName: 'v1', name: 'First' }, analysis: 'TAKE NOTHING' }], '2026-06-24');
  assert.match(md, /Nothing here has been implemented or shipped/);
  assert.match(md, /a\/b v1 \(First\)/);
  assert.match(md, /TAKE NOTHING/);
});

test('defaultConfig watches the two rivals', () => {
  assert.deepEqual(radar.defaultConfig().repos, ['NousResearch/hermes-agent', 'openclaw/openclaw']);
});

test('analyzeArgs spawns the brain hardened: no ambient MCP, no tools, non-interactive (release notes are untrusted)', () => {
  const a = radar.analyzeArgs('THE PROMPT');
  assert.deepEqual(a.slice(0, 2), ['-p', 'THE PROMPT']);            // the prompt is a single argv element, never shelled
  assert.ok(a.includes('--strict-mcp-config'));                     // no ambient MCP servers (also prevents the interactive-auth hang)
  const ti = a.indexOf('--allowedTools'); assert.ok(ti >= 0 && a[ti + 1] === '');  // zero tools: injected notes can not make it act
  const pi = a.indexOf('--permission-mode'); assert.ok(pi >= 0 && a[pi + 1] === 'acceptEdits');  // never stalls on a permission prompt
  assert.ok(a.includes('--model'));                                 // model is pinned, not left to the slow default
});

test('brainEnv strips the parent Claude Code session markers so a nested claude -p does not try to attach', () => {
  const dirty = { PATH: '/x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'keep-me' };
  const clean = radar.brainEnv(dirty);
  for (const k of radar.NESTED_CLAUDE_ENV) assert.ok(!(k in clean), k + ' should be stripped');
  assert.equal(clean.ANTHROPIC_API_KEY, 'keep-me');                 // provider routing is preserved
  assert.equal(clean.PATH, '/x');
  assert.ok(!('CLAUDECODE' in clean) && dirty.CLAUDECODE === '1');   // the caller's env object is not mutated
});
