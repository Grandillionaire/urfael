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
