'use strict';
// app/engine/default-brain.js — the PURE decision + shape-mapper for the NATIVE DEFAULT BRAIN.
//
// When the owner has PINNED a native provider as the default brain, the local voice/overlay turn (daemon.js
// brain.ask) may run on the in-process native engine instead of the CLI subscription. This module answers the ONE
// question that gate asks: given the pinned provider id and this turn's text, should the turn run natively, and if
// so, what brain.ask-shaped result does the native run produce? Every dependency (registry lookup, adapter pick,
// secret store, the runNativeTurn choke point, the overlay stream hooks, the clock) is INJECTED, so this is unit-
// testable with hand-driven fakes and network-free (the "no API key" bar) — the daemon binds the real deps.
//
// DOCTRINE it upholds by construction:
//  • FAIL-SOFT: it returns null on ANY miss (unpinned / unresolvable pin / CLI-only entry / keyless / native error),
//    so brain.ask falls through UNCHANGED to the CLI subscription path — the turn is never dropped. Never throws
//    (runNativeTurn itself never throws; wrapped anyway).
//  • BYTE-IDENTICAL DEFAULT: nativeDefault is null by default, so nativeDefaultResult short-circuits to null and the
//    daemon's whole native branch is skipped — the subscription path is untouched.
//  • FAIL-CLOSED / NARROW-ONLY: a keyless pin degrades to the subscription (never onto the daemon's own creds); the
//    read-only floor is inherited verbatim because the only way to reach a native turn is runNativeTurn (unchanged),
//    which builds the fail-closed toolset with allowShell/runShell UNSET.

// The persisted pin is only ever a sanitized provider-id string: [a-z0-9-] only, empty → null. Single-sourced so the
// load path, the setter, and the unit test all agree; a hostile value can never smuggle a path/flag/newline into the
// state file, and a value that sanitizes to empty degrades to "no pin" (the byte-identical default).
function sanitizeBrainId(id) {
  const clean = (typeof id === 'string' && id) ? id.replace(/[^a-z0-9-]/g, '') : '';
  return clean || null;
}

// nativeDefaultResult(nativeDefault, text, deps) -> brain.ask-shaped result | null.
// deps: {
//   routeOverride(text) -> truthy when THIS turn carries an explicit "/opus …" per-turn override,
//   findProvider(list, id) -> registry entry | null,
//   providers() -> the live provider list,
//   pickAdapter(entry) -> adapter info | null (null = a CLI-only/subscription entry),
//   secretNeeded(entry) -> { env } | null,
//   hasSecret(env) -> boolean,
//   resetStream({ model }) -> void (overlay clears + associates this turn's stream; also the daemon's turn bookkeeping),
//   runNativeTurn({ text, providerId, model, onDelta, onThinking }) -> Promise<{ ok, text, model, usage:{inTok,outTok}, ... }>,
//   onDelta(text) / onThinking(text) -> void stream sinks,
//   now() -> ms clock,
// }
async function nativeDefaultResult(nativeDefault, text, deps) {
  if (!nativeDefault) return null;                                  // not pinned → never entered (the byte-identical default)
  if (deps.routeOverride(text)) return null;                       // explicit "/opus …" wins the subscription tier for THIS turn
  const entry = deps.findProvider(deps.providers(), nativeDefault);
  if (!entry) return null;                                         // the pin is no longer in the registry → fall through
  if (!deps.pickAdapter(entry)) return null;                       // a CLI-only/subscription entry can't be a native brain (defensive; the endpoint already rejects it)
  const need = deps.secretNeeded(entry);
  if (need && !deps.hasSecret(need.env)) return null;              // keyless pin degrades gracefully to the subscription until a key is set
  try { deps.resetStream({ model: entry.big_model || entry.small_model || '' }); } catch {}   // overlay clears + associates the stream (parity with the CLI path)
  const t0 = deps.now();
  let r;
  try {
    r = await deps.runNativeTurn({
      text, providerId: entry.id, model: '',
      onDelta: deps.onDelta, onThinking: deps.onThinking,
    });
  } catch { return null; }                                          // runNativeTurn never throws; guard anyway → fall through (fail-soft)
  if (!r || !r.ok || !r.text) return null;                         // provider/build/native error → fall through to the CLI (fail-soft). runNativeTurn only records on success, so falling through never double-records.
  // MAP to brain.ask's exact contract so the reply flows through the /ask consumer (the selfset self-rewrite scan)
  // unchanged. runNativeTurn already did transcript.push + recordSession + logEvent('native_turn'); the native path
  // deliberately scopes out the CLI-tail reviewTurn/modelUser/reinforceSurfaced (documented v1 limitation).
  return {
    text: r.text, model: r.model, ms: deps.now() - t0, aborted: false,
    usage: {
      input_tokens: (r.usage && r.usage.inTok) || 0,
      output_tokens: (r.usage && r.usage.outTok) || 0,
      cache_read_input_tokens: 0,
    },
  };
}

module.exports = { sanitizeBrainId, nativeDefaultResult };
