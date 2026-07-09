'use strict';
// pet.js — "the Familiar": a pure, dependency-free, side-effect-free, never-throws state machine plus a
// code-drawn pose/frame provider for Urfael's agent-state companion.
//
// Provenance: idea from NousResearch/hermes-agent (MIT), patterns only — the notion of a labelled agent-state
// companion — re-implemented from scratch over Urfael's OWN runic identity, STATE_COLORS, and TOOL_RUNE families.
// No code was copied; this is a clean-room re-implementation of the pattern, drawn in code (never a sprite atlas).
//
// It is fed ONLY UI state the surfaces have ALREADY derived (the same signals that colour the orb and pick the
// worker verb today). It has zero imports, opens nothing, reads nothing, and cannot reach the daemon, its private
// 0600 channel, the transcript, or the cost ledger — so it is provably free of any brain impact by construction,
// not by promise. Every entry point is TOTAL and fails closed rather than throwing.

// The 7-member SUPERSET of Hermes's five agent states.
//   The five:  idle · thinking · tool · waiting · failed
//   Two voice-native extras the orb already earns, honestly labelled: listening (mic open) · speaking (TTS out).
const AGENT_STATES = Object.freeze(['idle', 'thinking', 'tool', 'waiting', 'failed', 'listening', 'speaking']);
const _MEMBER = Object.freeze({ idle: 1, thinking: 1, tool: 1, waiting: 1, failed: 1, listening: 1, speaking: 1 });

// runeForTool(tool): map a real tool name to the implement rune the Familiar "wields", by family, so the pose
// stays honest about the actual work in hand. This mirrors the SAME five families the worker row already names
// (memory ᛗ / shell ᛏ / web ᚱ / read ᛚ / write-edit ᚲ) but is Urfael's own local map — this module imports nothing.
function runeForTool(tool) {
  const t = String(tool == null ? '' : tool).toLowerCase();
  if (/mem|recall|grep|glob/.test(t)) return 'ᛗ';           // memory family (checked first: "search_memory" is memory)
  if (/bash|shell|script/.test(t)) return 'ᛏ';              // shell / hands-on
  if (/web|search|scry/.test(t)) return 'ᚱ';                // web / afar
  if (/read|ledger|open|view/.test(t)) return 'ᛚ';          // read / consult
  if (/writ|edit|commit|patch/.test(t)) return 'ᚲ';         // write / edit
  return 'ᛟ';                                               // a generic tool rune
}

// mapState(surfaceState, sig): TOTAL, fail-closed. Maps a surface's already-derived UI state plus a signal bag
// { tool, aborted, error, failed } onto exactly one AGENT_STATES member. Any unknown / garbage input degrades to
// 'idle'. A terminal failure (abort or a stream error/timeout) wins; a live tool in hand wins over plain thinking.
function mapState(surfaceState, sig) {
  try {
    sig = (sig && typeof sig === 'object') ? sig : {};
    if (sig.aborted === true || sig.error === true || sig.failed === true) return 'failed';
    if (typeof sig.tool === 'string' && sig.tool.trim() !== '') return 'tool';   // a real tool is always a non-empty name
    const s = String(surfaceState == null ? '' : surfaceState).toLowerCase();
    if (s === 'capturing') return 'listening';               // the orb's mic-open alias
    return _MEMBER[s] ? s : 'idle';
  } catch { return 'idle'; }
}

// poseFor(state): numeric pose params for the orb's vector Familiar — posture (body lean/height, centred at 0.5),
// eye (openness 0..1), limb (appendage reach 0..1, e.g. raising the implement), glow (aura 0..1). The orb draws
// these with its OWN canvas primitives + STATE_COLORS; tool/waiting/failed have no colour key, so they tint via
// the orb's existing STATE_COLORS[x] || STATE_COLORS.idle fallback plus these distinct postures. Unknown → idle.
const POSES = Object.freeze({
  idle:      { posture: 0.50, eye: 0.68, limb: 0.18, glow: 0.30 },
  thinking:  { posture: 0.62, eye: 0.44, limb: 0.34, glow: 0.55 },
  tool:      { posture: 0.58, eye: 0.86, limb: 0.92, glow: 0.66 },   // leaning in, arm extended to the implement
  waiting:   { posture: 0.40, eye: 0.28, limb: 0.14, glow: 0.24 },   // dozing, low and dim
  failed:    { posture: 0.22, eye: 0.14, limb: 0.10, glow: 0.20 },   // slumped
  listening: { posture: 0.55, eye: 1.00, limb: 0.30, glow: 0.72 },   // alert, eyes wide
  speaking:  { posture: 0.60, eye: 0.80, limb: 0.46, glow: 0.82 },   // animated
});
function poseFor(state) {
  try { const p = POSES[state]; return p ? { posture: p.posture, eye: p.eye, limb: p.limb, glow: p.glow } : poseFor('idle'); }
  catch { return { posture: 0.5, eye: 0.68, limb: 0.18, glow: 0.30 }; }
}

// The Familiar's own calm cadence (independent of the worker fps): one pose every FRAME_MS of wall-clock. Frame
// index is a PURE function of elapsed = now - t0, so a dropped tick SKIPS a frame (never stutters, zero drift).
const FRAME_MS = 220;

// Per-state pose cycles as short Unicode clusters (a runic head + a cycling accent), plus a plain 7-bit ASCII face
// for basic terminals and a single static pose for reduce-motion. Tool is handled specially so it shows the real
// implement rune. Each frame is width-modest (the caller's clipPad measures + clips, so it can never over-run).
const CYCLES = Object.freeze({
  idle:      ['ᚢ ', 'ᚢ·', 'ᚢˑ', 'ᚢ·'],
  thinking:  ['ᚢ˚', 'ᚢ∘', 'ᚢ°', 'ᚢ∘'],
  waiting:   ['ᚢ ', 'ᚢ‧', 'ᚢ ', 'ᚢ‧'],
  failed:    ['ᚢˎ'],
  listening: ['ᚢ⟩', 'ᚢ⟫', 'ᚢ⟩'],
  speaking:  ['ᚢ∼', 'ᚢ≈', 'ᚢ≋', 'ᚢ≈'],
});
const ASCII = Object.freeze({ idle: '(-)', thinking: '(o)', tool: '(*)', waiting: '(.)', failed: '(x)', listening: '(<)', speaking: '(~)' });

function _cycleFor(state, tool) {
  if (state === 'tool') { const r = runeForTool(tool); return ['ᚢ' + r, 'ᛝ' + r, 'ᚢ' + r]; }   // raising / lowering the implement
  return CYCLES[state] || CYCLES.idle;
}
function _frameIndex(t0, now, len) {
  const a = Number(t0), b = Number(now);
  if (!isFinite(a) || !isFinite(b) || !(len > 0)) return 0;
  const elapsed = b - a;
  if (!isFinite(elapsed) || elapsed <= 0) return 0;
  const i = Math.floor(elapsed / FRAME_MS);
  if (!isFinite(i) || i < 0) return 0;
  return ((i % len) + len) % len;
}

// frameTUI(state, t0, now, opts): the worker-line prefix pose. opts = { unicode, reduceMotion, tool }.
//   unicode === false  → a plain 7-bit ASCII face (every char < 128), for non-UTF-8 / non-256-colour terminals.
//   reduceMotion       → one static Unicode pose (no cycling), so screen-reader / reduced-motion users see no churn.
//   otherwise          → the wall-clock-pure animated cycle (index = floor(elapsed / FRAME_MS)).
// TOTAL: any garbage state fails closed to 'idle'; it never throws on any input.
function frameTUI(state, t0, now, opts) {
  try {
    opts = (opts && typeof opts === 'object') ? opts : {};
    const st = _MEMBER[state] ? state : 'idle';
    if (opts.unicode === false) return ASCII[st] || ASCII.idle;
    const cyc = _cycleFor(st, opts.tool);
    if (opts.reduceMotion) return cyc[0];
    return cyc[_frameIndex(t0, now, cyc.length)];
  } catch { return '(-)'; }
}

const _API = { AGENT_STATES, mapState, poseFor, frameTUI, runeForTool, FRAME_MS };

// Dual export: Node (the TUI requires it) via module.exports; the Electron renderer (a bare <script> with no module
// system) via a single global. The load is side-effect-free beyond defining that one global — it opens nothing.
if (typeof module !== 'undefined' && module.exports) module.exports = _API;
if (typeof window !== 'undefined') window.UrfaelPet = _API;
