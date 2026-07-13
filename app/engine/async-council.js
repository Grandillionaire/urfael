'use strict';
// app/engine/async-council.js — the OPT-IN (URFAEL_COUNCIL_ASYNC=1), summary-only, DETACHED-from-the-terminal async
// Council driver. It REUSES the daemon's single-sourced councilDeps + app/council.js VERBATIM — the crown-jewel
// read-only floor (council.intersectTools) never leaves councilDeps, so the detached workers are byte-identical to the
// sync round table. This module only ORCHESTRATES the pieces around council.runCouncil: the summary-only emit adapter
// (appends to the jobstore NDJSON log ONLY — never a response stream, never the shared `active`/sendSay voice writer),
// the id-scoped SIGKILL abort closure, the on-completion phone push (through the daemon's OWN notifyOwner sanitizer,
// never hand-rolled), the transparency-ledger lines, and the single-flight release. Everything that touches the world
// is INJECTED, so the whole surface is unit-testable with fakes (no daemon socket, no real claude).
//
// HONESTY: "detached from your terminal, reconciled on restart" — NOT crash-immortal. A daemon restart kills an
// in-flight council; jobstore.reconcile() then flips its stale 'running' record to 'interrupted' (pid gone).

// The SUMMARY-ONLY emit adapter for a detached council. It ONLY appends the NDJSON line to the jobstore log (so
// `urfael council --replay <id>` works after the fact) and captures the final synthesis + abort/error signals into
// `sink`. It has NO handle on a response stream or the daemon's voice writer, so a background council can never leak
// onto the owner's live turn — that property is STRUCTURAL, not a discipline.
function makeAsyncEmit(jobstore, id, sink) {
  return (o) => {
    try { jobstore.appendLog(id, JSON.stringify({ id, ...o })); } catch {}
    if (!o) return;
    if (o.ev === 'council.done' && typeof o.answer === 'string' && o.answer && !sink.answer) sink.answer = o.answer;
    else if (o.ev === 'council.aborted') sink.aborted = true;
    else if (o.ev === 'council.error') sink.err = sink.err || String(o.msg || o.reason || 'engine error');
  };
}

// The id-scoped abort closure: SIGKILL every tracked worker, drop it from the shutdown-reaper set, and clear the set.
// Identical in contract to the sync /council + MoA-brain abort, so a detached council is just as killable.
function makeAbort(children, inflightScoped) {
  return () => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch {} if (inflightScoped) inflightScoped.delete(c); }
    children.clear();
  };
}

// Drive ONE detached council to completion, OFF the daemon's request/response cycle. The caller has ALREADY replied
// 200 {id,state:'running',async:true} to the client (immediate detach) and set the single-flight; this returns a
// promise that settles when the council finishes. It runs council.runCouncil with the daemon's OWN councilDeps(id)
// (read-only floor intact), persists via that deps' store hook, then — ALWAYS, even on a throw — phones the owner a
// caveated, summary-only push (speak:false), writes the council_push/council_done ledger lines, and releases the
// single-flight. Never rejects for a council fault: a fault becomes an 'interrupted' record + a caveated push.
async function runDetached(o) {
  const { runCouncil, task, opts, deps, jobstore, id, notifyOwner, logEvent, release } = o;
  const sink = { answer: '', aborted: false, err: '' };
  const emit = makeAsyncEmit(jobstore, id, sink);
  try {
    const cr = await runCouncil(task, opts, emit, deps);
    if (cr && typeof cr.answer === 'string' && cr.answer && !sink.answer) sink.answer = cr.answer;
    if (cr && cr.aborted) sink.aborted = true;
  } catch (e) {
    sink.err = sink.err || String((e && e.message) || e).slice(0, 160);
    try { jobstore.update(id, { state: 'interrupted', endedAt: new Date().toISOString() }); } catch {}
  } finally {
    // Summary-only phone push. The synthesis can embed UNTRUSTED vault content, so we NEVER hand-roll the notifier —
    // notifyOwner strips \ " and space-prefixes a leading '-' (arg-injection). The caveat states it is unreviewed.
    const summary = String(sink.answer || (sink.err ? '(the council could not finish: ' + sink.err + ')' : '(the council returned no answer)')).slice(0, 280);
    try { notifyOwner('Council adjourned in the background (unreviewed by you), sir: ' + summary, { speak: false }); } catch {}
    try { logEvent({ ev: 'council_push', id }); } catch {}
    try { logEvent({ ev: 'council_done', id, source: 'async', ok: !sink.err && !sink.aborted }); } catch {}
    try { release(); } catch {}
  }
  return sink;
}

// ID-SCOPED cancel: only the CURRENTLY in-flight detached council (councilJobId === id) may be cancelled, so a wrong
// id can never SIGKILL the wrong council. On a match: fire the abort (SIGKILLs tracked children), mark the record
// 'interrupted', log council_cancel, and answer 200; otherwise 404.
function cancelDetached(o) {
  const { id, councilJobId, councilAbort, jobstore, logEvent } = o;
  if (councilJobId === id && councilAbort) {
    try { councilAbort(); } catch {}
    try { jobstore.update(id, { state: 'interrupted', endedAt: new Date().toISOString() }); } catch {}
    try { logEvent({ ev: 'council_cancel', id, ok: true }); } catch {}
    return { ok: true, code: 200 };
  }
  return { ok: false, code: 404 };
}

module.exports = { makeAsyncEmit, makeAbort, runDetached, cancelDetached };
