'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyModel, segmentSentences, MODELS, resolveProfile, normalizeReminder, normalizeCron, nextOccurrence, normalizeHook, hashHookSecret, hookSecretOk, parseCron, nextCronTime } = require('../lib');

test('routing: code/dev → Opus', () => {
  for (const q of ['debug this python function', 'refactor the auth module', 'push my code to the repo', 'architect a caching layer'])
    assert.equal(classifyModel(q), MODELS.opus, q);
});

test('routing: chat/admin/writing → Sonnet', () => {
  for (const q of ['hey what is up', "what's on my calendar", 'draft an email to Alex', 'add a meeting tomorrow at 3pm'])
    assert.equal(classifyModel(q), MODELS.sonnet, q);
});

test('routing: "report" must not trip "repo"', () => {
  assert.equal(classifyModel('write a report on Q2'), MODELS.sonnet);
});

test('profile: local keeps full power (no tool allowlist, inherits permission mode)', () => {
  const p = resolveProfile('local');
  assert.equal(p.name, 'local');
  assert.equal(p.permissionMode, null);   // daemon applies PERM_MODE / URFAEL_YOLO
  assert.equal(p.allowedTools, null);      // no restriction
  assert.equal(p.trustFraming, false);
});

test('profile: untrusted is sandboxed (no bypass, READ-ONLY tools, framed)', () => {
  const p = resolveProfile('untrusted');
  assert.equal(p.name, 'untrusted');
  assert.equal(p.permissionMode, 'acceptEdits');     // never bypassPermissions
  assert.ok(Array.isArray(p.allowedTools) && p.allowedTools.length);
  // read-only, no network egress: exactly Read/Grep/Glob — no write, no shell, no web (exfil) tool
  assert.deepEqual([...p.allowedTools].sort(), ['Glob', 'Grep', 'Read']);
  for (const banned of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'])
    assert.ok(!p.allowedTools.includes(banned), 'no ' + banned);
  assert.ok(!p.allowedTools.some((t) => /^Bash/.test(t)), 'no Bash at all (git can exec)');
  assert.equal(p.trustFraming, true);
});

test('profile: FAIL-CLOSED — unknown/empty/non-string channel resolves to untrusted, never local', () => {
  // strings that aren't exactly 'local'
  for (const name of ['telegram', 'discord', 'whatsapp', '', 'LOCAL', 'admin', undefined, null, 'local '])
    assert.equal(resolveProfile(name).name, 'untrusted', JSON.stringify(name));
  // type-coercion attacks: a non-string must NOT key-coerce its way to the local profile
  for (const name of [['local'], [['local']], { toString: () => 'local' }, 0, { name: 'local' }])
    assert.equal(resolveProfile(name).name, 'untrusted', JSON.stringify(name));
  // and every fail-closed result must carry the restricted controls (never local's nulls)
  for (const name of ['telegram', ['local'], { toString: () => 'local' }, undefined, 0]) {
    const p = resolveProfile(name);
    assert.notEqual(p.permissionMode, null, 'permMode set: ' + JSON.stringify(name));
    assert.ok(Array.isArray(p.allowedTools) && p.allowedTools.length, 'allowlist set: ' + JSON.stringify(name));
    assert.equal(p.trustFraming, true, 'framed: ' + JSON.stringify(name));
  }
});

test('segment: emits only complete sentences, keeps remainder', () => {
  const { sentences, rest } = segmentSentences('Hello there. How are you', false);
  assert.deepEqual(sentences, ['Hello there.']);
  assert.equal(rest, 'How are you');
});

test('segment: no premature break under the clause threshold', () => {
  const { sentences } = segmentSentences('a short clause with no terminator yet', false);
  assert.deepEqual(sentences, []);
});

test('segment: force flushes the trailing remainder', () => {
  const { sentences, rest } = segmentSentences('the final trailing bit', true);
  assert.deepEqual(sentences, ['the final trailing bit']);
  assert.equal(rest, '');
});

test('segment: multiple sentences in one buffer', () => {
  const { sentences } = segmentSentences('One. Two! Three? ', false);
  assert.deepEqual(sentences, ['One.', 'Two!', 'Three?']);
});

// ---- reminders ----
const NOW = Date.parse('2026-06-10T12:00:00Z');

test('reminder: inMins schedules relative to now', () => {
  const r = normalizeReminder({ text: 'call Stefan', inMins: 20 }, NOW);
  assert.equal(r.at, NOW + 20 * 60000);
  assert.equal(r.text, 'call Stefan');
  assert.equal(r.repeat, null);
});

test('reminder: absolute at (ISO) accepted', () => {
  const r = normalizeReminder({ text: 'standup', at: '2026-06-10T15:00:00Z' }, NOW);
  assert.equal(r.at, Date.parse('2026-06-10T15:00:00Z'));
});

test('reminder: fail-closed on garbage', () => {
  for (const bad of [null, 'x', [], { text: 'no time' }, { inMins: 5 }, { text: '', inMins: 5 },
    { text: 'bad date', at: 'not-a-date' }, { text: 'neg', inMins: NaN }])
    assert.equal(normalizeReminder(bad, NOW), null, JSON.stringify(bad));
});

test('reminder: one-shot in the past rejected; repeating in the past allowed (rolls forward)', () => {
  assert.equal(normalizeReminder({ text: 'late', at: '2026-06-10T10:00:00Z' }, NOW), null);
  const r = normalizeReminder({ text: 'daily', at: '2026-06-10T08:00:00Z', repeat: 'daily' }, NOW);
  assert.ok(r && r.repeat === 'daily');
  assert.ok(nextOccurrence(r, NOW));
  assert.ok(r.at > NOW && r.at <= NOW + 86400000);
});

test('reminder: bounds clamped — max 1y out, everyMins floored to 5', () => {
  assert.equal(normalizeReminder({ text: 'far', at: '2031-01-01T00:00:00Z' }, NOW), null);
  const r = normalizeReminder({ text: 'spam', inMins: 1, repeat: { everyMins: 1 } }, NOW);
  assert.equal(r.repeat.everyMins, 5);
});

test('reminder: nextOccurrence advances repeats past now, false for one-shots', () => {
  const one = { at: NOW - 1000, repeat: null };
  assert.equal(nextOccurrence(one, NOW), false);
  const wk = { at: NOW - 1000, repeat: 'weekly' };
  assert.ok(nextOccurrence(wk, NOW));
  assert.ok(wk.at > NOW && wk.at <= NOW + 604800000);
  const ev = { at: NOW - 10 * 3600000, repeat: { everyMins: 60 } };
  assert.ok(nextOccurrence(ev, NOW));
  assert.ok(ev.at > NOW && ev.at <= NOW + 3600000);
});

// ---- cron (scheduled agent jobs) ----
test('cron: inMins one-shot, deliver defaults to notify', () => {
  const c = normalizeCron({ prompt: 'summarize my inbox', inMins: 30 }, NOW);
  assert.equal(c.at, NOW + 30 * 60000);
  assert.equal(c.prompt, 'summarize my inbox');
  assert.equal(c.deliver, 'notify');
  assert.equal(c.repeat, null);
});

test('cron: absolute at (ISO) accepted', () => {
  const c = normalizeCron({ prompt: 'check the deploy', at: '2026-06-10T18:00:00Z' }, NOW);
  assert.equal(c.at, Date.parse('2026-06-10T18:00:00Z'));
  assert.equal(c.repeat, null);
});

test('cron: everyMins repeat carries a usable first fire + clamps to >= 5', () => {
  const c = normalizeCron({ prompt: 'poll status', inMins: 5, repeat: { everyMins: 15 } }, NOW);
  assert.deepEqual(c.repeat, { everyMins: 15 });
  assert.equal(c.at, NOW + 5 * 60000);
  const floored = normalizeCron({ prompt: 'spam', inMins: 1, repeat: { everyMins: 1 } }, NOW);
  assert.equal(floored.repeat.everyMins, 5);
  const capped = normalizeCron({ prompt: 'rare', inMins: 1, repeat: { everyMins: 999999 } }, NOW);
  assert.equal(capped.repeat.everyMins, 43200); // 30d ceiling
});

test('cron: daily/weekly repeat past start rolls forward via nextOccurrence', () => {
  const c = normalizeCron({ prompt: 'daily brief', at: '2026-06-10T08:00:00Z', repeat: 'daily' }, NOW);
  assert.ok(c && c.repeat === 'daily');
  assert.ok(nextOccurrence(c, NOW));
  assert.ok(c.at > NOW && c.at <= NOW + 86400000);
});

test('cron: dailyAt:"HH:MM" parsing seeds first fire at next occurrence of that local time', () => {
  const c = normalizeCron({ prompt: 'morning digest', repeat: { dailyAt: '07:30' } }, NOW);
  assert.ok(c && c.repeat === 'daily');
  const d = new Date(c.at);
  assert.equal(d.getHours(), 7);
  assert.equal(d.getMinutes(), 30);
  assert.ok(c.at > NOW);                         // always a future first fire
  assert.ok(c.at <= NOW + 86400000);             // within the next 24h
});

test('cron: dailyAt out-of-range / malformed is rejected (fail-closed)', () => {
  for (const bad of [{ prompt: 'p', repeat: { dailyAt: '25:00' } }, { prompt: 'p', repeat: { dailyAt: '7:5' } },
    { prompt: 'p', repeat: { dailyAt: '12:60' } }, { prompt: 'p', repeat: { dailyAt: 'noon' } }])
    assert.equal(normalizeCron(bad, NOW), null, JSON.stringify(bad));
});

test('cron: deliver mode is allowlisted (silent/push kept, anything else -> notify)', () => {
  assert.equal(normalizeCron({ prompt: 'p', inMins: 5, deliver: 'silent' }, NOW).deliver, 'silent');
  assert.equal(normalizeCron({ prompt: 'p', inMins: 5, deliver: 'push' }, NOW).deliver, 'push');
  for (const d of ['notify', 'shout', '', null, 7, {}])
    assert.equal(normalizeCron({ prompt: 'p', inMins: 5, deliver: d }, NOW).deliver, 'notify', JSON.stringify(d));
});

test('cron: fail-closed on missing prompt / garbage / bad repeat', () => {
  for (const bad of [null, 'x', [], { inMins: 5 }, { prompt: '', inMins: 5 }, { prompt: '   ', inMins: 5 },
    { prompt: 'p' }, { prompt: 'p', inMins: NaN }, { prompt: 'p', at: 'not-a-date' },
    { prompt: 'p', inMins: 5, repeat: 'hourly' }, { prompt: 'p', inMins: 5, repeat: { everyMins: 'lots' } }])
    assert.equal(normalizeCron(bad, NOW), null, JSON.stringify(bad));
});

test('cron: bounds clamped — one-shot past rejected, >1y rejected, prompt truncated', () => {
  assert.equal(normalizeCron({ prompt: 'late', at: '2026-06-10T10:00:00Z' }, NOW), null); // one-shot in the past
  assert.equal(normalizeCron({ prompt: 'far', at: '2031-01-01T00:00:00Z' }, NOW), null);  // > 1y out
  const long = normalizeCron({ prompt: 'x'.repeat(5000), inMins: 5 }, NOW);
  assert.equal(long.prompt.length, 2000);                                                 // prompt capped at 2000
  // a repeating job dated in the past is allowed (rolls forward), unlike a one-shot
  const rep = normalizeCron({ prompt: 'recurring', at: '2026-06-10T10:00:00Z', repeat: 'daily' }, NOW);
  assert.ok(rep && rep.repeat === 'daily');
});

// ---- TEAM / MULTI-OWNER MODE (security kernel) ----
const { profileFor, buildRoster, resolvePrincipal } = require('../lib');

test('team: a role can only NARROW access — NO role value ever reaches "local"', () => {
  // every conceivable role input (incl forged/coerced) must map to a remote-sandboxed profile, never local.
  for (const r of ['owner', 'member', 'guest', 'OWNER', 'local', '', null, undefined, 0, ['owner'], { toString: () => 'owner' }, 'admin', 'root'])
    assert.notEqual(profileFor(r).name, 'local', JSON.stringify(r));
});

test('team: owner/member get read+search (untrusted); guest is more restricted (Read only, no search)', () => {
  assert.equal(profileFor('owner').name, 'untrusted');
  assert.equal(profileFor('member').name, 'untrusted');
  assert.deepEqual(profileFor('owner').allowedTools.sort(), ['Glob', 'Grep', 'Read']);
  const g = profileFor('guest');
  assert.equal(g.name, 'guest');
  assert.deepEqual(g.allowedTools, ['Read']);             // no Grep/Glob → cannot browse/search the vault
  assert.ok(!g.allowedTools.some((t) => /Grep|Glob|Bash|Write|Edit|WebFetch|WebSearch/.test(t)));
  assert.equal(g.trustFraming, true);
});

test('team: an unknown/missing/forged role FAILS CLOSED to guest (most restricted)', () => {
  for (const r of ['', 'admin', 'superuser', null, undefined, 42, {}, []])
    assert.equal(profileFor(r).name, 'guest', JSON.stringify(r));
});

test('team: resolvePrincipal allowlist is fail-closed — only a listed id resolves; everyone else is dropped (null)', () => {
  const roster = { telegram: [{ id: '111', name: 'Maxim', role: 'owner' }, { id: '222', name: 'Sam', role: 'member' }] };
  assert.equal(resolvePrincipal(roster, 'telegram', '111').name, 'Maxim');
  assert.equal(resolvePrincipal(roster, 'telegram', '222').role, 'member');
  assert.equal(resolvePrincipal(roster, 'telegram', '999'), null, 'a stranger is dropped');
  assert.equal(resolvePrincipal(roster, 'discord', '111'), null, 'right id, wrong channel is dropped');
  assert.equal(resolvePrincipal(roster, 'telegram', { id: '111' }), null, 'an object id cannot coerce-match');
  assert.equal(resolvePrincipal(null, 'telegram', '111'), null);
});

test('team: a listed principal with an unknown role is downgraded to guest (never escalated)', () => {
  const roster = { telegram: [{ id: '1', name: 'X', role: 'admin' }, { id: '2', name: 'Y' }] };
  assert.equal(resolvePrincipal(roster, 'telegram', '1').role, 'guest');
  assert.equal(resolvePrincipal(roster, 'telegram', '2').role, 'guest');
});

test('team: buildRoster falls back to the single-owner env, and team.json overrides per channel', () => {
  // env-only → one owner per channel (backward-compatible)
  const env = buildRoster(null, { telegram: '111', discord: '222' });
  assert.equal(env.telegram[0].id, '111'); assert.equal(env.telegram[0].role, 'owner');
  assert.equal(env.discord[0].id, '222');
  // team.json present for a channel → it is the source of truth for that channel
  const merged = buildRoster({ telegram: [{ id: 'a', name: 'A', role: 'owner' }, { id: 'b', name: 'B', role: 'guest' }] }, { telegram: '111', discord: '222' });
  assert.equal(merged.telegram.length, 2);
  assert.equal(merged.telegram[0].id, 'a');
  assert.equal(merged.telegram[1].role, 'guest');
  assert.equal(merged.discord[0].id, '222', 'channels not in team.json keep the env owner');
});

test('team: buildRoster tolerates junk and dedups ids (fail-soft)', () => {
  const r = buildRoster({ telegram: [{ id: '1', role: 'owner' }, null, { name: 'no-id' }, { id: '1', role: 'guest' }, { id: 2, name: 'two', role: 'bogus' }] }, {});
  assert.equal(r.telegram.length, 2, 'null + id-less dropped; duplicate id collapsed');
  assert.equal(r.telegram[0].id, '1');
  assert.equal(r.telegram[1].role, 'guest', 'bogus role normalized to guest');
});

// ---- team.json editors (urfael team add/remove) ----
const { addPrincipal, removePrincipal, TEAM_CHANNELS } = require('../lib');

test('team add: adds a principal, defaults role to member-or-guest, dedups+updates by id', () => {
  let { team, error } = addPrincipal({}, 'telegram', { id: '111', name: 'Maxim', role: 'owner' });
  assert.equal(error, null);
  assert.equal(team.telegram.length, 1);
  assert.deepEqual(team.telegram[0], { id: '111', name: 'Maxim', role: 'owner' });
  // a second id appends
  ({ team } = addPrincipal(team, 'telegram', { id: '222', name: 'Sam' }));
  assert.equal(team.telegram.length, 2);
  assert.equal(team.telegram[1].role, 'guest'); // no role -> fail-closed guest
  // re-adding the same id UPDATES, not duplicates
  ({ team } = addPrincipal(team, 'telegram', { id: '111', name: 'Max', role: 'member' }));
  assert.equal(team.telegram.length, 2);
  assert.equal(team.telegram.find((p) => p.id === '111').role, 'member');
});

test('team add: rejects an unknown channel and a missing id (never throws, never mutates input)', () => {
  const input = {};
  assert.ok(/unknown channel/.test(addPrincipal(input, 'nope', { id: '1' }).error));
  assert.ok(/id is required/.test(addPrincipal(input, 'telegram', {}).error));
  assert.deepEqual(input, {}, 'input is not mutated');
  for (const c of TEAM_CHANNELS) assert.equal(addPrincipal({}, c, { id: 'x', role: 'owner' }).error, null);
});

test('team remove: removes by id, reports removed, drops the channel when empty', () => {
  const start = { telegram: [{ id: '111', role: 'owner' }, { id: '222', role: 'member' }] };
  let { team, removed } = removePrincipal(start, 'telegram', '222');
  assert.equal(removed, true);
  assert.equal(team.telegram.length, 1);
  // removing the last one drops the channel key
  ({ team, removed } = removePrincipal(team, 'telegram', '111'));
  assert.equal(removed, true);
  assert.ok(!('telegram' in team));
  // removing a non-member reports false
  assert.equal(removePrincipal(start, 'telegram', '999').removed, false);
});

// ---- FORTRESS vs FULL mode (the secure-default + opt-in-capable switch) ----
test('mode: FORTRESS is the default — owner/member remote turns stay read-only, no egress', () => {
  for (const m of [undefined, 'fortress', '', 'FORTRESS', 'nonsense', null]) {
    const p = profileFor('owner', m);
    assert.equal(p.name, 'untrusted', 'default/fortress = untrusted for ' + JSON.stringify(m));
    assert.ok(!p.allowedTools.some((t) => /WebFetch|WebSearch|Write|Edit|Bash/.test(t)), 'no egress/write in fortress');
  }
});

test('mode: FULL widens owner/member to WEB+SEARCH reach — but NO write, shell, bypass, or unframed', () => {
  const p = profileFor('member', 'full');
  assert.equal(p.name, 'full');
  assert.ok(p.allowedTools.includes('WebFetch') && p.allowedTools.includes('WebSearch') && p.allowedTools.includes('Grep'), 'web + search + read');
  assert.ok(!p.allowedTools.some((t) => /Write|Edit/.test(t)), 'FULL mode has NO Write/Edit (acceptEdits is not a cwd jail -> a write could escape the vault)');
  assert.ok(!p.allowedTools.some((t) => /Bash/.test(t)), 'FULL mode still has NO unsandboxed shell');
  assert.equal(p.permissionMode, 'acceptEdits'); assert.notEqual(p.permissionMode, 'bypassPermissions');
  assert.equal(p.trustFraming, true, 'remote content is still untrusted-framed in full mode');
});

test('mode: a GUEST is restricted in BOTH modes, and NO mode/role ever reaches "local"', () => {
  assert.equal(profileFor('guest', 'full').name, 'guest');
  assert.deepEqual(profileFor('guest', 'full').allowedTools, ['Read']);
  for (const role of ['owner', 'member', 'guest', 'admin', '', null, ['owner']])
    for (const mode of ['fortress', 'full', undefined, 'LOCAL'])
      assert.notEqual(profileFor(role, mode).name, 'local', JSON.stringify([role, mode]));
});

// ---- CRON-SYNTAX (5-field) ----------------------------------------------------------------------------
test('cron-syntax: parseCron accepts valid exprs (*, lists, ranges, steps) and rejects malformed ones', () => {
  for (const ok of ['* * * * *', '*/15 * * * *', '0 9 * * 1-5', '30 8,12,18 * * *', '0 0 1 1 *', '5-50/5 0 * * 0'])
    assert.ok(parseCron(ok), ok);
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 7', 'a * * * *', '*/0 * * * *', '5-2 * * * *', '', 7, null])
    assert.equal(parseCron(bad), null, JSON.stringify(bad));
});
test('cron-syntax: nextCronTime finds the next matching minute (strictly after), local time', () => {
  const base = new Date(2026, 5, 12, 9, 17, 30).getTime();   // Fri 2026-06-12 09:17:30 local
  const at = nextCronTime(parseCron('*/15 * * * *'), base);  // next quarter-hour
  const d = new Date(at);
  assert.equal(d.getMinutes(), 30); assert.equal(d.getSeconds(), 0); assert.ok(at > base);
  // weekday 09:00 — from Fri 09:17 the next 9am weekday is Monday
  const mon = new Date(nextCronTime(parseCron('0 9 * * 1-5'), base));
  assert.equal(mon.getDay(), 1); assert.equal(mon.getHours(), 9); assert.equal(mon.getMinutes(), 0);
});
test('cron-syntax: dom/dow OR-semantics (both restricted → either matches)', () => {
  // "0 0 13 * 5" = midnight on the 13th OR any Friday
  const f = parseCron('0 0 13 * 5');
  const fromThu = new Date(2026, 5, 11, 12, 0, 0).getTime(); // Thu Jun 11
  const next = new Date(nextCronTime(f, fromThu));
  // next is Fri Jun 12 (a Friday) at 00:00 — earlier than the 13th
  assert.equal(next.getDate(), 12); assert.equal(next.getDay(), 5); assert.equal(next.getHours(), 0);
});
test('cron-syntax: normalizeCron seeds the first fire from a cron repeat + nextOccurrence rolls it forward', () => {
  const NOWX = new Date(2026, 5, 12, 9, 17, 0).getTime();
  const c = normalizeCron({ prompt: 'standup ping', repeat: { cron: '0 9 * * 1-5' } }, NOWX);
  assert.deepEqual(c.repeat, { cron: '0 9 * * 1-5' });
  assert.ok(c.at > NOWX);
  const first = c.at; nextOccurrence(c, first);              // advance past the first fire
  assert.ok(c.at > first, 'rolled forward to the next occurrence');
  assert.equal(normalizeCron({ prompt: 'p', repeat: { cron: 'bogus expr' } }, NOWX), null); // bad cron → fail-closed
});
test('cron-syntax: reminders accept cron too (first fire seeded, no explicit at needed)', () => {
  const NOWX = new Date(2026, 5, 12, 9, 17, 0).getTime();
  const r = normalizeReminder({ text: 'drink water', repeat: { cron: '0 */2 * * *' } }, NOWX);
  assert.ok(r && r.repeat.cron === '0 */2 * * *' && r.at > NOWX);
});

// ---- CRON: no-agent script jobs + chaining ------------------------------------------------------------
test('cron: agent job is unchanged + now tagged kind:"agent" (backward compatible)', () => {
  const c = normalizeCron({ prompt: 'summarize inbox', inMins: 10 }, NOW);
  assert.equal(c.kind, 'agent');
  assert.equal(c.prompt, 'summarize inbox');
  assert.equal(c.script, undefined);
});
test('cron: a no-LLM script job carries kind:"script" + script, no prompt', () => {
  const c = normalizeCron({ kind: 'script', script: 'curl -s https://api/health', inMins: 5 }, NOW);
  assert.equal(c.kind, 'script');
  assert.equal(c.script, 'curl -s https://api/health');
  assert.equal(c.prompt, undefined);
  assert.equal(normalizeCron({ kind: 'script', inMins: 5 }, NOW), null);   // script kind with no script → fail-closed
  assert.equal(normalizeCron({ kind: 'agent', inMins: 5 }, NOW), null);    // agent kind with no prompt → fail-closed
});
test('cron: a `then` chain is normalized recursively and depth-bounded', () => {
  const c = normalizeCron({ prompt: 'fetch report', inMins: 5, then: { prompt: 'summarize it', then: { kind: 'script', script: 'echo done' } } }, NOW);
  assert.equal(c.then.kind, 'agent');
  assert.equal(c.then.prompt, 'summarize it');
  assert.equal(c.then.then.kind, 'script');
  assert.equal(c.then.then.script, 'echo done');
  // a chain deeper than CHAIN_MAX is truncated, never infinite
  let deep = { prompt: 'leaf' }; for (let i = 0; i < 20; i++) deep = { prompt: 'step' + i, then: deep };
  const cc = normalizeCron({ ...deep, inMins: 5 }, NOW);
  let n = 0; for (let j = cc; j; j = j.then) n++;
  assert.ok(n <= 6, 'chain length bounded (<= CHAIN_MAX + root), got ' + n);
});
test('cron: a garbage `then` is dropped, the parent still schedules', () => {
  const c = normalizeCron({ prompt: 'ok', inMins: 5, then: { nonsense: true } }, NOW);
  assert.ok(c && !c.then, 'unusable then is omitted, parent survives');
});

// ---- WEBHOOK EVENT TRIGGERS ----------------------------------------------------------------------------
test('hook: normalize defaults action=ask deliver=notify, clamps name, strips control chars', () => {
  assert.deepEqual(normalizeHook({ name: 'deploy done' }), { name: 'deploy done', action: 'ask', deliver: 'notify' });
  assert.deepEqual(normalizeHook({ name: 'x', action: 'notify', deliver: 'push' }), { name: 'x', action: 'notify', deliver: 'push' });
  assert.equal(normalizeHook({ name: 'a'.repeat(200) }).name.length, 60);              // clamped
  assert.equal(normalizeHook({ name: 'be\x00ll\x07' }).name, 'be ll');                  // control chars → space
});
test('hook: normalize is fail-closed (unusable spec → null; unknown action/deliver fall back safely)', () => {
  for (const bad of [null, undefined, 'x', [], {}, { name: '' }, { name: '   ' }, { name: 7 }])
    assert.equal(normalizeHook(bad), null, JSON.stringify(bad));
  assert.equal(normalizeHook({ name: 'x', action: 'shell' }).action, 'ask');            // unknown action → ask, NEVER a new power
  assert.equal(normalizeHook({ name: 'x', action: 'Bash' }).action, 'ask');
  assert.equal(normalizeHook({ name: 'x', deliver: 'email' }).deliver, 'notify');
});
test('hook: a RELAY needs a valid owner-set http(s) replyUrl (fail-closed without one)', () => {
  const r = normalizeHook({ name: 'teams', action: 'relay', replyUrl: 'https://example.com/hook/abc', replyAuth: 'Bearer xyz' });
  assert.equal(r.action, 'relay');
  assert.equal(r.replyUrl, 'https://example.com/hook/abc');
  assert.equal(r.replyAuth, 'Bearer xyz');
  // a relay with no / a bad / a non-http / an SSRF reply URL is unusable → null (never fires with nowhere safe to reply)
  for (const bad of [{ name: 'x', action: 'relay' }, { name: 'x', action: 'relay', replyUrl: '' },
    { name: 'x', action: 'relay', replyUrl: 'not a url' }, { name: 'x', action: 'relay', replyUrl: 'file:///etc/passwd' },
    { name: 'x', action: 'relay', replyUrl: 'ftp://host/x' }, { name: 'x', action: 'relay', replyUrl: 7 },
    // SSRF — the reply body is attacker-steered, so a private/loopback/metadata target is a write primitive → refused
    { name: 'x', action: 'relay', replyUrl: 'http://127.0.0.1/x' }, { name: 'x', action: 'relay', replyUrl: 'http://169.254.169.254/latest/meta-data' },
    { name: 'x', action: 'relay', replyUrl: 'https://localhost:9000/x' }, { name: 'x', action: 'relay', replyUrl: 'http://10.0.0.5/x' },
    { name: 'x', action: 'relay', replyUrl: 'http://192.168.1.1/x' }, { name: 'x', action: 'relay', replyUrl: 'http://[::1]/x' }])
    assert.equal(normalizeHook(bad), null, JSON.stringify(bad));
  // ask/notify never carry a replyUrl even if one is passed (no outbound target for them)
  assert.equal(normalizeHook({ name: 'x', action: 'ask', replyUrl: 'https://evil/x' }).replyUrl, undefined);
});
test('hook: secret is checked by HASH, constant-time, and a wrong/garbage secret never validates', () => {
  const secret = 'a'.repeat(64);
  const stored = hashHookSecret(secret);
  assert.match(stored, /^[0-9a-f]{64}$/);                                                // sha256 hex
  assert.notEqual(stored, secret);                                                       // never stores the plaintext
  assert.equal(hookSecretOk(secret, stored), true);                                      // correct secret → ok
  for (const wrong of ['', 'b'.repeat(64), secret + 'x', secret.slice(1), 7, null, {}, [secret]])
    assert.equal(hookSecretOk(wrong, stored), false, JSON.stringify(wrong));
  // a malformed/empty stored hash (e.g. a corrupt registry) must NEVER validate, even against its own preimage
  for (const badStore of ['', '0'.repeat(64), 'zz', stored.toUpperCase(), null])
    assert.equal(hookSecretOk(secret, badStore), false, JSON.stringify(badStore));
});
