'use strict';
// app/teams-vtt.js — the PURE core of the Teams meeting-transcript pipeline. Microsoft Graph hands back a meeting
// transcript as WebVTT; this turns it (DATA only, no I/O, never throws) into a speaker-attributed markdown note for
// the vault, where the existing recall/distill machinery indexes it for free. A transcript is third-party speech =
// UNTRUSTED, so everything here is defensive and the runner relays any summarization through the daemon's sandboxed
// 'teams' channel. The runner (teams-transcript.js) does the Graph fetch/auth/cron; this module is fully testable.

// parseVtt(text) → [{ start, end, speaker, text }]. Handles the WebVTT `<v Speaker>…</v>` voice tag Teams emits,
// strips any other inline tags, drops empty/headerless cues. Never throws.
function parseVtt(text) {
  const cues = [];
  for (const block of String(text == null ? '' : text).replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const m = lines[ti].match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!m) continue;
    const raw = lines.slice(ti + 1).join('\n');
    let speaker = '', body = raw;
    const vm = raw.match(/<v\s+([^>]+?)>([\s\S]*?)(?:<\/v>|$)/i);
    if (vm) { speaker = vm[1].trim(); body = vm[2]; }
    body = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    cues.push({ start: m[1], end: m[2], speaker, text: body });
  }
  return cues;
}

// mergeCues → collapse consecutive same-speaker cues into one utterance (keeps the first start, last end).
function mergeCues(cues) {
  const out = [];
  for (const c of (Array.isArray(cues) ? cues : [])) {
    const last = out[out.length - 1];
    if (last && last.speaker === c.speaker) { last.text += ' ' + c.text; last.end = c.end; }
    else out.push({ start: c.start, end: c.end, speaker: c.speaker, text: c.text });
  }
  return out;
}
function speakers(cues) { return [...new Set((cues || []).map((c) => c.speaker).filter(Boolean))]; }
function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'meeting'; }

// buildNote(meta, cues) → the markdown note string the runner writes into the vault. PARA + house style: a logo
// header, YAML frontmatter (with transcriptId for idempotency), a participants line, then the merged speaker body.
// All meta/transcript text is plain markdown (no executable content); a YAML-special char in a field is quoted.
function buildNote(meta, cues) {
  const merged = mergeCues(parseCuesArg(cues));
  const fmv = (v) => { const s = String(v == null ? '' : v); return /[:#\[\]{}",]/.test(s) ? JSON.stringify(s) : s; };
  const fm = ['---',
    'created: ' + fmv(meta && meta.created), 'type: meeting-transcript', 'tags: [teams, transcript]',
    'meetingId: ' + fmv(meta && meta.meetingId), 'transcriptId: ' + fmv(meta && meta.transcriptId),
    'organizer: ' + fmv(meta && meta.organizer), 'start: ' + fmv(meta && meta.start), 'end: ' + fmv(meta && meta.end),
    '---'].join('\n');
  const body = merged.length ? merged.map((c) => '**' + (c.speaker || 'Unknown') + '** _(' + c.start + ')_: ' + c.text).join('\n\n') : '_(no transcribed speech)_';
  return '![[urfael-logo.svg|90]]\n\n' + fm + '\n\n# ' + String((meta && meta.title) || 'Teams meeting') + '\n\n**Participants:** ' + (speakers(merged).join(', ') || '—') + '\n\n' + body + '\n';
}
function parseCuesArg(cues) { return (Array.isArray(cues) && cues.length && cues[0] && 'text' in cues[0]) ? cues : parseVtt(cues); }

// noteFilename(meta) → a stable, collision-resistant name: YYYY-MM-DD-HHMM-<slug>.md (date from meta.start).
function noteFilename(meta) {
  const d = String((meta && meta.start) || '').replace(/[^0-9T:-]/g, '');
  const stamp = (d.match(/(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/) || [])[0] ? d.slice(0, 10) + '-' + d.slice(11, 13) + d.slice(14, 16) : 'undated';
  return stamp + '-' + slugify((meta && meta.title) || (meta && meta.meetingId) || 'meeting') + '.md';
}

module.exports = { parseVtt, mergeCues, speakers, slugify, buildNote, noteFilename };
