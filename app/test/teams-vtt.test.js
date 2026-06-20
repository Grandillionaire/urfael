'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../teams-vtt');

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Alice Smith>Morning everyone, let's start.</v>

2
00:00:04.500 --> 00:00:07.000
<v Alice Smith>First item is the launch date.</v>

3
00:00:07.500 --> 00:00:10.000
<v Bob Jones>I think Friday works.</v>

4
00:00:10.500 --> 00:00:12.000


5
00:00:12.000 --> 00:00:14.000
A line with <b>no</b> voice tag.`;

test('parseVtt extracts cues with speakers, strips inline tags, and drops empty cues', () => {
  const cues = t.parseVtt(VTT);
  assert.equal(cues.length, 4);                 // the whitespace-only cue is dropped
  assert.deepEqual(cues[0], { start: '00:00:01.000', end: '00:00:04.000', speaker: 'Alice Smith', text: "Morning everyone, let's start." });
  assert.equal(cues[3].speaker, '');            // no voice tag → empty speaker
  assert.equal(cues[3].text, 'A line with no voice tag.');   // <b> stripped
  assert.deepEqual(t.parseVtt(''), []);
  assert.deepEqual(t.parseVtt(null), []);       // never throws
});

test('mergeCues collapses consecutive same-speaker utterances', () => {
  const merged = t.mergeCues(t.parseVtt(VTT));
  assert.equal(merged.length, 3);               // Alice's two cues merge into one
  assert.equal(merged[0].speaker, 'Alice Smith');
  assert.equal(merged[0].text, "Morning everyone, let's start. First item is the launch date.");
  assert.equal(merged[0].end, '00:00:07.000');  // last end kept
});

test('speakers dedups the participant list', () => {
  assert.deepEqual(t.speakers(t.mergeCues(t.parseVtt(VTT))), ['Alice Smith', 'Bob Jones']);
});

test('buildNote produces a logo-headed note with frontmatter (incl. transcriptId for idempotency) + participants + body', () => {
  const note = t.buildNote({ title: 'Launch sync', meetingId: 'M1', transcriptId: 'T9', organizer: 'alice@x.com', start: '2026-06-20T09:00:00Z', end: '2026-06-20T09:30:00Z', created: '2026-06-20' }, t.parseVtt(VTT));
  assert.ok(note.startsWith('![[urfael-logo.svg|90]]'));
  assert.match(note, /type: meeting-transcript/);
  assert.match(note, /transcriptId: T9/);
  assert.match(note, /\*\*Participants:\*\* Alice Smith, Bob Jones/);
  assert.match(note, /\*\*Alice Smith\*\* _\(00:00:01\.000\)_: Morning everyone/);
  // a YAML-special organizer is quoted so it can't break the frontmatter
  const note2 = t.buildNote({ organizer: 'a: b, c', title: 'x' }, []);
  assert.match(note2, /organizer: "a: b, c"/);
  assert.match(note2, /_\(no transcribed speech\)_/);   // empty transcript still yields a valid note
});

test('noteFilename is a stable YYYY-MM-DD-HHMM-slug.md from the meeting start', () => {
  assert.equal(t.noteFilename({ start: '2026-06-20T09:05:00Z', title: 'Launch Sync!' }), '2026-06-20-0905-launch-sync.md');
  assert.match(t.noteFilename({ title: 'x' }), /^undated-x\.md$/);
});
