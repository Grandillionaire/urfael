'use strict';
// app/provider-sessions.js — Concurrent providers, never interrupted.
//
// Today the daemon keys its warm Claude sessions by MODEL alone (`getSession(model)` over a model→Session Map).
// That collides the moment two providers expose the same tier alias: the subscription's 'sonnet' and an
// OpenRouter-backed 'sonnet' would share one warm process and one routing env — opening the second chat would
// silently hijack the first. This module is the PURE engine that makes many chats, each bound to a different
// model/provider (or the same model via a different method, e.g. API vs subscription), coexist without any of
// them disconnecting unless the owner says so.
//
// It is Node-stdlib-only, side-effect-free (no I/O beyond loadProviderRegistry, no spawn, no logging), and
// unit-testable in isolation. The daemon wires it in later (see the integrationSpec); nothing here imports the
// daemon, so a unit test never needs it running.
//
// SECURITY CONTRACT (load-bearing):
//   - resolveScopedEnv returns a NEW object for a CHILD spawn only. It NEVER mutates baseEnv, so the provider's
//     secret is never written back onto the daemon's own process env.
//   - The secret is consumed into the child env and is NEVER stored on the ChatRegistry. list()/get() return
//     SAFE metadata only (chatId, model, providerId, connected, lastActivity) — never the secret, never the env.
//   - All provider parsing/validation reuses app/providers.js, which fail-soft drops malformed / plain-http-remote
//     / flag-smuggling rows. A hostile registry can only ever yield FEWER providers here, never a bad env write.
//   - resolveScopedEnv emits ONLY keys from providers.MANAGED (the drift-frozen subset of the daemon's forwarded
//     allowlist), so a chat can never route the brain through an unmanaged variable.

const providers = require('./providers');

// ── sessionKey ────────────────────────────────────────────────────────────────────────────────────
// Stable composite key for the warm-session Map. Replaces today's model-only keying so two providers' 'sonnet'
// (or the same model reached two ways, e.g. the flat-rate subscription vs an API key) get SEPARATE warm
// processes and never collide. Deterministic + collision-resistant: provider id and model are length-prefixed so
// no pair of (providerId, model) inputs can alias to another. Missing/empty parts normalize to '' (never throws),
// matching providers.js fail-soft style; an empty providerId yields a legacy-shaped 'model' bucket on its own.
function sessionKey(model, providerId) {
  const m = String(model == null ? '' : model);
  const pid = providers.slugify(providerId || '');
  // length-prefix the provider id so 'a' + 'bc' can't collide with 'ab' + 'c'; ':' joins the two fields.
  return pid.length + ':' + pid + ':' + m;
}

// ── loadProviderRegistry ────────────────────────────────────────────────────────────────────────────
// Parse the curated registry from config/providers.json (or a path the owner points URFAEL_PROVIDERS_INDEX at).
// Pure delegation to providers.load → providers.parse, so it inherits every validation + the fail-soft contract.
// Returns [] on any read/parse error. Same shape the daemon already trusts.
function loadProviderRegistry(providersJsonPath) {
  return providers.load(providersJsonPath || providers.registryPath());
}

// findProvider — resolve a chat's providerId to its validated registry entry (or null). Convenience over
// providers.find so callers don't need to import providers.js directly.
function findProvider(list, providerId) {
  return providers.find(list || [], providerId);
}

// ── resolveScopedEnv ────────────────────────────────────────────────────────────────────────────────
// Build the env for ONE child spawn bound to `providerEntry`. Returns a NEW object:
//   1. start from a shallow copy of baseEnv (never the original reference),
//   2. apply providers.resolveEnv(entry, secret).clear  → delete every MANAGED routing var the previous
//      provider may have set (so one chat's routing never leaks into another's),
//   3. apply .set → overlay this provider's ANTHROPIC_* / model / backend vars (and, for key auth, the secret).
//
// The secret lives ONLY on the returned object. baseEnv is untouched, so the daemon's own process env never
// gains the secret and a later chat on a different provider starts from a clean base. Throws (via resolveEnv)
// when a key-auth provider is missing its secret — the caller must surface that, never spawn without it.
function resolveScopedEnv(baseEnv, providerEntry, secret) {
  if (!providerEntry) throw new Error('no provider');
  const env = Object.assign({}, baseEnv || {});           // a fresh object — baseEnv is read-only here
  const delta = providers.resolveEnv(providerEntry, secret);   // { clear:[...MANAGED], set:{var:value} }
  for (const k of delta.clear) delete env[k];             // clear stale routing from any prior provider
  for (const k of Object.keys(delta.set)) env[k] = delta.set[k];
  return env;
}

// ── ChatRegistry ──────────────────────────────────────────────────────────────────────────────────
// The in-memory book of open chats. Each chat is bound to (model, providerId); many coexist. A chat stays
// `connected` until the owner explicitly disconnects it — registering or disconnecting one chat never touches
// any other. Holds ONLY safe metadata: it never stores a secret, an env object, or a child handle, so list()
// can be returned in /vitals and audit lines without leaking anything.
class ChatRegistry {
  constructor(opts = {}) {
    this._chats = new Map();                              // chatId -> { chatId, model, providerId, connected, createdAt, lastActivity }
    this._seq = 0;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();   // injectable clock for tests
  }

  // newChatId — an unguessable, URL/key-safe id for a fresh chat. crypto-random; the monotonic seq prefix only
  // guarantees uniqueness within a process so two same-tick registrations can't collide.
  newChatId() {
    const rand = require('crypto').randomBytes(9).toString('hex');
    return 'c' + (++this._seq).toString(36) + '-' + rand;
  }

  // register(chatId, {model, providerId}) — open (or rebind) a chat bound to a model+provider. An explicit
  // chatId is honored (and validated); omit it to mint a fresh one. The secret is NEVER passed here or stored —
  // it is resolved per-spawn via resolveScopedEnv at the call site and lives only in the child env.
  register(chatId, spec = {}) {
    const id = (chatId != null && String(chatId).trim()) ? String(chatId).slice(0, 80) : this.newChatId();
    const model = String((spec && spec.model) || '').slice(0, 80);
    const providerId = providers.slugify((spec && spec.providerId) || '');
    const t = this._now();
    const existing = this._chats.get(id);
    const rec = {
      chatId: id,
      model,
      providerId,
      connected: true,
      key: sessionKey(model, providerId),                // the warm-session bucket this chat routes to
      createdAt: existing ? existing.createdAt : t,
      lastActivity: t,
    };
    this._chats.set(id, rec);
    return this._safe(rec);
  }

  // get(chatId) — safe metadata for one chat, or null. Includes the sessionKey so the daemon knows which warm
  // Session bucket to route the turn to; never the secret.
  get(chatId) {
    const rec = this._chats.get(String(chatId));
    return rec ? this._safe(rec) : null;
  }

  // has(chatId) — cheap existence check.
  has(chatId) { return this._chats.has(String(chatId)); }

  // list() — SAFE metadata for every chat (for /vitals + audit). Never the secret, never an env object.
  // Newest-activity first so the HUD shows the live chats at the top.
  list() {
    return [...this._chats.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((r) => this._safe(r));
  }

  // activeChats — only the still-connected chats (what /vitals should surface as "running now").
  activeChats() { return this.list().filter((c) => c.connected); }

  // markActivity(chatId) — bump lastActivity on a turn (and re-confirm connected). Returns true if the chat
  // exists. The daemon calls this whenever a chat sends or receives a turn, so an idle-vs-live view is possible.
  markActivity(chatId) {
    const rec = this._chats.get(String(chatId));
    if (!rec) return false;
    rec.lastActivity = this._now();
    rec.connected = true;
    return true;
  }

  // disconnect(chatId) — the ONLY thing that drops a chat, and only the named one. Marks it disconnected and
  // returns its key so the caller can decide whether the underlying warm Session is now unreferenced and may be
  // torn down (a Session is shared by composite key, so it is only safe to kill when NO connected chat maps to
  // it — see keyInUse). Returns null if the chat is unknown. Idempotent.
  disconnect(chatId) {
    const rec = this._chats.get(String(chatId));
    if (!rec) return null;
    rec.connected = false;
    rec.lastActivity = this._now();
    return { chatId: rec.chatId, key: rec.key, keyStillInUse: this.keyInUse(rec.key) };
  }

  // remove(chatId) — forget a chat entirely (e.g. after its Session is reaped). disconnect keeps the row for
  // audit; remove is the hard delete. Returns true if a row was removed.
  remove(chatId) { return this._chats.delete(String(chatId)); }

  // keyInUse(key) — is any STILL-CONNECTED chat bound to this composite session key? The daemon uses this before
  // tearing down a warm Session: never kill a bucket another live chat still routes through.
  keyInUse(key) {
    for (const r of this._chats.values()) if (r.connected && r.key === key) return true;
    return false;
  }

  // size — number of tracked chats (connected + disconnected-but-retained).
  get size() { return this._chats.size; }

  // _safe — the projection that leaves the registry. Explicit allowlist of fields so a future addition (a secret,
  // an env, a child pid) can NEVER leak just by being added to the internal record.
  _safe(rec) {
    return {
      chatId: rec.chatId,
      model: rec.model,
      providerId: rec.providerId,
      connected: rec.connected,
      key: rec.key,
      createdAt: rec.createdAt,
      lastActivity: rec.lastActivity,
    };
  }
}

module.exports = {
  sessionKey,
  loadProviderRegistry,
  findProvider,
  resolveScopedEnv,
  ChatRegistry,
};
