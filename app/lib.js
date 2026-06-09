'use strict';
// Pure, unit-testable logic shared by main.js and the test suite.
// (Extracted so the race-prone bits — routing + sentence segmentation — are actually covered.)

// Model tiers, as Claude Code aliases ('sonnet'/'opus') so they always resolve to the latest
// model your plan supports — no pinned IDs to rot, no source edits when Anthropic ships a new one.
// Override per machine via env (set in the daemon plist's EnvironmentVariables), e.g. a Pro plan with
// no Opus access: JARVIS_OPUS_MODEL=sonnet. You can also pin an exact id like 'claude-opus-4-8'.
const MODELS = {
  sonnet: process.env.JARVIS_SONNET_MODEL || 'sonnet',
  opus: process.env.JARVIS_OPUS_MODEL || 'opus',
};

// Pick the model tier for an utterance: Opus for hard work (code, deep reasoning, architecture,
// analysis); Sonnet for everything else — it still reasons. No Haiku.
function classifyModel(text) {
  const t = (text || '').toLowerCase();
  if (/\b(code|coding|program|function|debug|bug|refactor|repos?\b|git|api|python|javascript|typescript|rust|golang|sql|regex|compile|deploy|terminal|stack ?trace|build|script|class|architect|algorithm|optimi[sz]e|figure out|think through|reason|trade.?off|complex|in.?depth|step.?by.?step|analy[sz]e|hard problem)\b/.test(t)) return MODELS.opus;
  return MODELS.sonnet;
}

// Permission profiles — the STRUCTURAL sandbox for remote/untrusted turns.
// The daemon maps each /ask to a profile by its `channel`: the local voice overlay sends no channel
// (=> 'local', full power); every remote channel (telegram/discord/…) is sandboxed. resolveProfile is
// FAIL-CLOSED: any unknown or missing name returns the most-restricted 'untrusted' profile, never 'local'.
//   permissionMode null  -> daemon uses its own default (PERM_MODE / JARVIS_YOLO). Reachable ONLY by 'local'.
//   allowedTools   null  -> inherit (no tool restriction). Otherwise an explicit allowlist passed to claude.
//   trustFraming         -> wrap the user text in an untrusted-data envelope (prompt-injection mitigation).
const PROFILES = {
  // the on-machine owner at the mic/overlay: unchanged behaviour, may use bypass only if JARVIS_YOLO=1.
  local: { permissionMode: null, allowedTools: null, trustFraming: false },
  // anything arriving over a network channel: never bypass, no computer-use, read/search/web/notes/git only.
  untrusted: {
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'Bash(git:*)'],
    trustFraming: true,
  },
};
function resolveProfile(name) {
  const known = Object.prototype.hasOwnProperty.call(PROFILES, name);
  const p = known ? PROFILES[name] : PROFILES.untrusted; // fail-closed: unknown => untrusted
  return { name: known ? name : 'untrusted', ...p };
}

// Pull complete sentences from a streaming buffer for incremental TTS.
// Returns { sentences: string[], rest: string }. `force` flushes the remainder at end-of-turn.
function segmentSentences(buf, force) {
  let s = buf;
  const sentences = [];
  const re = /^([\s\S]*?[.!?…]+)(\s|$)/;
  let m;
  while ((m = re.exec(s))) { const x = m[1].trim(); if (x) sentences.push(x); s = s.slice(m[0].length); }
  if (!force && s.length > 170) { const i = s.lastIndexOf(' '); if (i > 60) { sentences.push(s.slice(0, i).trim()); s = s.slice(i + 1); } }
  if (force && s.trim()) { sentences.push(s.trim()); s = ''; }
  return { sentences, rest: s };
}

module.exports = { MODELS, classifyModel, segmentSentences, resolveProfile };
