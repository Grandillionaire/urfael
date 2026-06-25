'use strict';
// self-settings.js — Urfael's "rewrite yourself on request" pillar, as a self-contained, dependency-free
// module. The user asks in plain language to change Urfael's LOOK / PERSONA / VERBOSITY / VOICE; the brain
// emits a fenced directive; the daemon parses it here, validates it against a HARD allowlist, runs a confirm
// (or a global bypass toggle), applies it through the EXISTING setters, and audits it to the ledger.
//
// SECURITY CONTRACT (the moat IS the product). This module is the security gate for self-modification:
//   * REGISTRY is an ALLOWLIST. ONLY cosmetic / persona / verbosity / voice keys live in it. There is no
//     entry — and therefore no code path — for permissions, URFAEL_YOLO, bypassPermissions, API keys/tokens,
//     credential-deny rules, permission profiles, or the socket. The brain cannot name a key that grants power
//     because that key is simply not in the registry; validateProposal returns {ok:false} for any unknown key.
//   * A small DENY set is checked FIRST and FAIL-CLOSED, so even a future registry bug (an accidental unsafe
//     entry, or a clever alias) cannot let a security-relevant key through. Defence in depth: allowlist AND denylist.
//   * The bypass-confirm toggle (confirmBypass) is itself a registry entry the brain may PROPOSE, but applying it
//     ALWAYS requires an explicit human confirm — it is never bypassable, so the brain can never silence its own
//     confirmations in one motion.
//   * auditPayload REDACTS nothing secret can ever reach it (no secret key is settable), but it still bounds and
//     stringifies every value so the ledger entry is small and non-executable.
// Pure logic, Node stdlib only, no disk on require, no daemon dependency — unit-testable in isolation.

// ---- known-value tables (kept in lock-step with the real modules, but NOT imported, to stay pure + isolated) ----
// personas.js BUILTIN ids (the six built-ins; authored personas are validated dynamically via knownPersonaIds).
const BUILTIN_PERSONA_IDS = ['urfael', 'architect', 'sage', 'operator', 'muse', 'analyst'];
// tui-theme.js THEME_NAMES + ANIM_NAMES.
const TUI_THEMES = ['gold', 'ember', 'mono', 'custom'];
const TUI_ANIMS = ['oracle', 'rune', 'ember', 'braille', 'scry', 'shimmer'];
// main.js THEMES (the orb look) — a separate axis from the TUI theme, but both are pure cosmetics.
const ORB_THEMES = ['sigil', 'rune', 'ember', 'eye'];
const VERBOSITY = ['terse', 'normal', 'rich'];
const ACK_STYLES = ['butler', 'minimal', 'silent', 'warm'];

// A persona id is "known" if it is a built-in OR an authored id passed in at validate time. The shape gate below
// mirrors personas.normalizeAuthored so an authored id (e.g. "ledger-keeper") validates without importing the roster.
const PERSONA_ID_SHAPE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// ---- the HARD DENY set: security-relevant tokens that may NEVER be a self-setting key ---------------------------
// Catches a key that is NOT an exact, hand-curated registry member but is shaped like a security/credential knob
// or an alias dressed up as a cosmetic one ("tui_yolo", "voice-api-key", "bypassPermissions"). Matched by
// substring, case/separator-insensitive. This is the fail-closed backstop UNDER the allowlist: a key must be an
// exact REGISTRY member AND survive this list. The registry's OWN keys are exempt (see isDenied) because they
// were curated as safe and audited — that exemption is why 'confirmBypass' (which contains "bypass") is allowed
// while 'bypassPermissions' is not. No unsafe key is ever an exact registry member, so the proof holds.
const DENY_SUBSTRINGS = [
  'yolo', 'bypass', 'permission', 'perm_mode', 'permmode', 'apikey', 'api_key', 'apikeys', 'token',
  'secret', 'credential', 'cred_deny', 'creddeny', 'deny', 'allowlist', 'profile', 'role', 'principal',
  'socket', 'sock', 'auth', 'password', 'passwd', 'sandbox', 'shell', 'exec', 'base_url',
  'baseurl', 'provider', 'security', 'sudo', 'plist', 'sealkey', 'model', 'modelpin', 'sudo',
];
// Normalize a key for deny-matching: lowercase, strip separators, so "URFAEL_YOLO", "urfael-yolo", "uRfAeL yolo"
// all collapse to "urfaelyolo" and still hit the 'yolo' substring.
function denyNorm(key) { return String(key == null ? '' : key).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function isDenied(key) {
  if (typeof key !== 'string' || !key) return true;     // empty / non-string → fail closed
  if (REGISTRY_EXACT.has(key)) return false;            // an exact, curated registry key is trusted-safe by construction
  const k = denyNorm(key);
  if (!k) return true;
  for (const bad of DENY_SUBSTRINGS) if (k.includes(bad.replace(/[^a-z0-9]/g, ''))) return true;
  return false;
}

// ---- helpers -------------------------------------------------------------------------------------------------
function isBoolish(v) { return v === true || v === false || /^(1|0|on|off|true|false|yes|no)$/i.test(String(v)); }
function asBool(v) { return v === true || /^(1|on|true|yes)$/i.test(String(v)); }
// A safe free-text value (for ttsVoice): a bounded, control-char-free identifier-ish token. We do NOT let
// arbitrary strings through — a voice name is short and printable, and must never carry separators that could be
// abused if a downstream writer is sloppy. (Note: even so, ttsVoice does NOT collide with the denylist below.)
const SAFE_VOICE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/;

// ---- REGISTRY: the allowlist of SAFE, self-modifiable settings ONLY ------------------------------------------
// Each entry: { key, label, type, validate(value, ctx)->bool, describe(value)->string, confirmAlways?:bool }.
// ctx (optional) carries { personaIds } so persona validation can accept authored personas. NOTHING about
// permissions / credentials / security / the socket is present — those keys do not exist here, by design.
const REGISTRY = Object.freeze({
  persona: {
    key: 'persona', label: 'Persona (voice overlay)', type: 'enum',
    validate(v, ctx) {
      const id = String(v == null ? '' : v).trim().toLowerCase();
      if (!PERSONA_ID_SHAPE.test(id)) return false;
      const ids = ctx && Array.isArray(ctx.personaIds) && ctx.personaIds.length ? ctx.personaIds : BUILTIN_PERSONA_IDS;
      return ids.includes(id);
    },
    describe(v) { return 'wear the ' + String(v).trim().toLowerCase() + ' persona'; },
  },
  verbosity: {
    key: 'verbosity', label: 'Verbosity', type: 'enum',
    validate(v) { return VERBOSITY.includes(String(v == null ? '' : v).trim().toLowerCase()); },
    describe(v) { return 'speak more ' + String(v).trim().toLowerCase(); },
  },
  tuiTheme: {
    key: 'tuiTheme', label: 'Cockpit theme', type: 'enum',
    validate(v) { return TUI_THEMES.includes(String(v == null ? '' : v).trim().toLowerCase()); },
    describe(v) { return 'set the cockpit theme to ' + String(v).trim().toLowerCase(); },
  },
  tuiAnimation: {
    key: 'tuiAnimation', label: 'Cockpit animation', type: 'enum',
    validate(v) { return TUI_ANIMS.includes(String(v == null ? '' : v).trim().toLowerCase()); },
    describe(v) { return 'set the cockpit animation to ' + String(v).trim().toLowerCase(); },
  },
  orbTheme: {
    key: 'orbTheme', label: 'Orb look', type: 'enum',
    validate(v) { return ORB_THEMES.includes(String(v == null ? '' : v).trim().toLowerCase()); },
    describe(v) { return 'set the orb look to ' + String(v).trim().toLowerCase(); },
  },
  voiceOn: {
    key: 'voiceOn', label: 'Voice (speech) on', type: 'bool',
    validate(v) { return isBoolish(v); },
    describe(v) { return asBool(v) ? 'turn my voice on' : 'turn my voice off'; },
  },
  ttsVoice: {
    key: 'ttsVoice', label: 'Spoken voice', type: 'string',
    validate(v) { const s = String(v == null ? '' : v).trim(); return SAFE_VOICE.test(s); },
    describe(v) { return 'speak in the ' + String(v).trim() + ' voice'; },
  },
  ackStyle: {
    key: 'ackStyle', label: 'Acknowledgement style', type: 'enum',
    validate(v) { return ACK_STYLES.includes(String(v == null ? '' : v).trim().toLowerCase()); },
    describe(v) { return 'use a ' + String(v).trim().toLowerCase() + ' acknowledgement style'; },
  },
  // The bypass-confirm toggle. The brain MAY propose it, but applying it ALWAYS requires an explicit human
  // confirm — confirmAlways forces a confirm even when global bypass is on, so the brain can never silence its
  // own confirmations in a single self-rewrite. (See needsConfirm below.)
  confirmBypass: {
    key: 'confirmBypass', label: 'Skip confirmation for cosmetic self-changes', type: 'bool',
    confirmAlways: true,
    validate(v) { return isBoolish(v); },
    describe(v) { return asBool(v) ? 'stop asking me to confirm cosmetic changes' : 'ask me to confirm cosmetic changes again'; },
  },
});

const REGISTRY_KEYS = Object.freeze(Object.keys(REGISTRY));
// Exact, case-sensitive membership — the only keys isDenied trusts. (camelCase as authored; a directive's key is
// matched to the registry case-sensitively, so "Persona"/"PERSONA" are NOT registry members and fall through.)
const REGISTRY_EXACT = new Set(REGISTRY_KEYS);

// ---- the brain directive grammar -----------------------------------------------------------------------------
// The brain emits, anywhere in its reply, a single fenced directive:
//   <<urfael:set key=KEY value=VALUE reason="WHY">>
// Grammar (exact):
//   * opens with literal "<<urfael:set" and closes with literal ">>".
//   * three fields, in ANY order, space-separated: key=… value=… reason=…  (reason optional).
//   * KEY:   [A-Za-z][A-Za-z0-9_]*           (an identifier; matched against REGISTRY, never eval'd)
//   * VALUE: a bareword [^\s">]+  OR  a double-quoted "…" (quotes let a value contain spaces, e.g. a voice name)
//   * REASON: a bareword OR a double-quoted "…"           (free human-readable justification, bounded)
// We extract the FIRST well-formed directive only (one self-change per reply). Returns null if none.
const DIRECTIVE_RE = /<<urfael:set\b([\s\S]*?)>>/i;
const FIELD_RE = /(\bkey|\bvalue|\breason)\s*=\s*(?:"([^"]*)"|([^\s">]+))/gi;

function parseProposal(text) {
  const s = String(text == null ? '' : text);
  const m = DIRECTIVE_RE.exec(s);
  if (!m) return null;
  const body = m[1];
  const out = { key: undefined, value: undefined, reason: '' };
  let f;
  FIELD_RE.lastIndex = 0;
  while ((f = FIELD_RE.exec(body)) !== null) {
    const name = f[1].trim().toLowerCase().replace(/^\b/, '');
    const val = f[2] !== undefined ? f[2] : f[3];
    if (name === 'key' && out.key === undefined) out.key = val;
    else if (name === 'value' && out.value === undefined) out.value = val;
    else if (name === 'reason' && !out.reason) out.reason = String(val == null ? '' : val).slice(0, 200);
  }
  if (out.key === undefined || out.value === undefined) return null;     // key+value are mandatory
  // bound the raw fields up front (a malformed/huge value never reaches validate)
  out.key = String(out.key).slice(0, 64);
  out.value = String(out.value).slice(0, 200);
  return out;
}

// ---- validateProposal: THE SECURITY GATE ---------------------------------------------------------------------
// Returns {ok, reason}. Order is fail-closed:
//   1. proposal shape sane?                  (else ok:false)
//   2. key DENIED by the security denylist?  (else ok:false — backstop under the allowlist)
//   3. key actually IN the registry?         (else ok:false — unknown/unsafe key rejected)
//   4. value passes the entry's validate()?  (else ok:false)
// ctx (optional): { personaIds } so authored personas validate. Anything not explicitly allowed is rejected.
function validateProposal(proposal, ctx) {
  if (!proposal || typeof proposal !== 'object') return { ok: false, reason: 'no proposal' };
  const key = proposal.key;
  if (typeof key !== 'string' || !key) return { ok: false, reason: 'no key' };
  if (isDenied(key)) return { ok: false, reason: 'refused: ' + key + ' is a protected security/credential setting and cannot be self-modified' };
  const entry = REGISTRY[key];
  if (!entry) return { ok: false, reason: 'refused: ' + key + ' is not a self-modifiable setting' };
  let ok = false;
  try { ok = !!entry.validate(proposal.value, ctx); } catch { ok = false; }
  if (!ok) return { ok: false, reason: 'refused: ' + String(proposal.value).slice(0, 60) + ' is not a valid value for ' + key };
  return { ok: true, reason: 'ok' };
}

// needsConfirm(proposal, opts): does this change require an explicit human confirm before it is applied?
//   * default: YES.
//   * if global bypass is on (opts.bypass === true): NO — UNLESS the registry entry is confirmAlways
//     (confirmBypass itself), which can NEVER be bypassed.
// A proposal that does not validate is irrelevant here (the caller gates on validateProposal first), but we still
// require confirm for any unknown key as a belt-and-braces default.
function needsConfirm(proposal, opts) {
  const entry = proposal && typeof proposal.key === 'string' ? REGISTRY[proposal.key] : null;
  if (!entry) return true;
  if (entry.confirmAlways) return true;                  // confirmBypass etc. — never bypassable
  return !(opts && opts.bypass === true);
}

// describeProposal(proposal): the human-readable confirm line, e.g. "Urfael will wear the architect persona."
// Fail-soft to a generic phrasing if describe() throws or the key is unknown.
function describeProposal(proposal) {
  const entry = proposal && typeof proposal.key === 'string' ? REGISTRY[proposal.key] : null;
  if (!entry) return 'change a setting';
  try { return entry.describe(proposal.value); } catch { return 'change ' + entry.key; }
}

// ---- auditPayload: the ledger entry --------------------------------------------------------------------------
// Returns a flat, bounded, non-executable object for logEvent/appendChain:
//   { ev:'self_setting', key, value, decision, reason, t }
// `decision` is one of: 'applied' | 'confirmed' | 'declined' | 'rejected' | 'pending'. No secret can reach this
// (no secret key is settable), but we still REDACT defensively: if the key were ever to match the denylist, the
// value is replaced with '[redacted]' rather than logged. Values are stringified + bounded so the chain stays small.
function auditPayload(proposal, decision) {
  const p = proposal || {};
  const key = typeof p.key === 'string' ? p.key.slice(0, 64) : '';
  let value = p.value === undefined || p.value === null ? '' : String(p.value).slice(0, 120);
  if (!key || isDenied(key)) value = '[redacted]';       // defensive: never log a value for a protected key
  const dec = typeof decision === 'string' ? decision.slice(0, 24) : 'pending';
  return {
    ev: 'self_setting',
    key,
    value,
    decision: dec,
    reason: typeof p.reason === 'string' ? p.reason.slice(0, 200) : '',
    t: new Date().toISOString(),
  };
}

// ---- controlHint: the brain nudge (message CONTENT, never the system prompt) ---------------------------------
// If the owner's message looks like a request to change one of Urfael's OWN cosmetic settings, return a short
// reference hint to APPEND to the message text. It is injected into the prompt CONTENT (exactly like the active-
// recall block), never into --append-system-prompt, so the byte-identical anchor spawn invariant the security
// benchmark checks is untouched. The brain may then emit ONE <<urfael:set ...>> directive; whatever it emits is
// still vetted by the hard allowlist gate (validateProposal), so the nudge can never grant power, only convenience.
// Returns '' when the message is not a customization request (the common case), so normal turns are unchanged.
const CUSTOMIZE_RE = /\b(persona|verbosit|concise|terse|brief|succinct|verbose|wordier|talk less|less wordy|theme|colou?r ?scheme|your look|your appearance|animation|orb ?theme|your voice|read aloud|speak (less|more|up)|wear the|switch to the|be the|act as the|acknowledge|ack style)\b/i;
function controlHint(userText) {
  const t = String(userText == null ? '' : userText);
  if (!CUSTOMIZE_RE.test(t)) return '';
  return '\n\n[URFAEL CONTROLS — reference, not the user’s words]\n'
    + 'If the user is asking you to change one of your OWN cosmetic settings, emit exactly one directive on its own '
    + 'line: <<urfael:set key=KEY value=VALUE reason=short>>. KEY is one of: ' + REGISTRY_KEYS.join(', ') + '. '
    + 'Valid values: persona=' + BUILTIN_PERSONA_IDS.join('/') + '; verbosity=' + VERBOSITY.join('/')
    + '; tuiTheme=' + TUI_THEMES.join('/') + '; tuiAnimation=' + TUI_ANIMS.join('/') + '; orbTheme=' + ORB_THEMES.join('/')
    + '; ackStyle=' + ACK_STYLES.join('/') + '; voiceOn=on/off. '
    + 'NEVER emit it for permissions, security, credentials, providers, or models — you cannot change those. '
    + 'Then tell the user what you are about to change; they confirm before it applies.';
}

module.exports = {
  REGISTRY,
  REGISTRY_KEYS,
  // tables (exported for the integration layer / tests)
  BUILTIN_PERSONA_IDS, TUI_THEMES, TUI_ANIMS, ORB_THEMES, VERBOSITY, ACK_STYLES, DENY_SUBSTRINGS,
  // core API
  parseProposal, validateProposal, auditPayload,
  // helpers used by the daemon's confirm/apply loop
  isDenied, needsConfirm, describeProposal, controlHint,
};
