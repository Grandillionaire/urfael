'use strict';
// app/router.js — COST/SPEED/QUALITY-AWARE PROVIDER ROUTING. Given the provider registry (each row carrying
// indicative 1..5 cost/speed/quality tiers) and a priority, recommend the best provider+model to switch to. PURE +
// unit-tested: no I/O, no env writes, no spawn (cli.js does the switch via providers.resolveEnv). Never throws.
//
// Better than a single-axis "sort by price" (OpenRouter style): this is PARETO-AWARE (it reports the whole
// non-dominated frontier, not just one sort key), EXPLAINABLE (every pick comes with a reason), and HONEST (the
// tiers are indicative, not benchmarks, and it flags when it routed on an unknown tier or away from the flat-rate
// Claude default). Routing is a deliberate switch, not per-turn (that would break the warm session), so this
// recommends and the user confirms.

// priority → axis weights. cost: cheap wins. speed: fast wins. quality: capable wins. balanced: even. privacy: local
// only, prefer the most capable local model. Weights are over normalized axes (cheapness, speed, quality), sum ~1.
const WEIGHTS = {
  cost: { c: 0.7, s: 0.1, q: 0.2 },
  speed: { c: 0.1, s: 0.7, q: 0.2 },
  quality: { c: 0.2, s: 0.1, q: 0.7 },
  balanced: { c: 0.34, s: 0.33, q: 0.33 },
  privacy: { c: 0.2, s: 0.2, q: 0.6 },
};
const PRIORITIES = Object.keys(WEIGHTS);

// normalized 0..1 axis values from a 1..5 tier (0/unknown → 0.5, a neutral midpoint, flagged separately).
const cheap = (cost) => (cost > 0 ? (5 - cost) / 4 : 0.5);
const fast = (speed) => (speed > 0 ? (speed - 1) / 4 : 0.5);
const good = (quality) => (quality > 0 ? (quality - 1) / 4 : 0.5);

// candidates(providers, opts) → one row per (provider, model). A provider with no models[] contributes one big-role
// candidate from its own tiers. Tiers fall back model → provider. local = a local-token server (nothing leaves box).
function candidates(providers) {
  const rows = [];
  for (const p of (Array.isArray(providers) ? providers : [])) {
    if (!p || !p.id) continue;
    const local = p.authKind === 'local';
    const base = { providerId: p.id, label: p.label || p.id, kind: p.kind, local, verified: !!p.verified, flatRate: !!p.flatRate, proxy: p.proxy };
    const models = Array.isArray(p.models) && p.models.length ? p.models : [{ id: p.big_model || '(provider default)', role: 'big', ctx: 0, tools: true, cost: 0, speed: 0, quality: 0 }];
    for (const m of models) {
      rows.push({
        ...base, model: m.id, role: m.role === 'small' ? 'small' : 'big', ctx: Number(m.ctx) || 0, tools: m.tools !== false,
        cost: m.cost || p.cost || 0, speed: m.speed || p.speed || 0, quality: m.quality || p.quality || 0,
      });
    }
  }
  return rows;
}

// does a dominate b on all three axes (cheaper-or-equal, faster-or-equal, better-or-equal) and strictly better on one?
function dominates(a, b) {
  const ge = cheap(a.cost) >= cheap(b.cost) && fast(a.speed) >= fast(b.speed) && good(a.quality) >= good(b.quality);
  const gt = cheap(a.cost) > cheap(b.cost) || fast(a.speed) > fast(b.speed) || good(a.quality) > good(b.quality);
  return ge && gt;
}

// the Pareto frontier: candidates not dominated by any other. The honest "these are the real tradeoffs" set.
function pareto(cands) {
  return (cands || []).filter((a) => !(cands || []).some((b) => b !== a && dominates(b, a)));
}

function score(c, w) { return w.c * cheap(c.cost) + w.s * fast(c.speed) + w.q * good(c.quality); }

// route(providers, opts) → { pick, frontier, considered, priority, weights, why }. opts:
//   priority: cost|speed|quality|balanced|privacy (default balanced) · role: big|small · needsTools · minCtx · localOnly
// Filters first, then ranks by the priority's weighted score; ties broken toward fewer caveats (verified, not a proxy).
function route(providers, opts) {
  const o = opts || {};
  const priority = PRIORITIES.includes(o.priority) ? o.priority : 'balanced';
  const localOnly = !!o.localOnly || priority === 'privacy';
  const w = WEIGHTS[priority];
  let cands = candidates(providers);
  if (o.role === 'big' || o.role === 'small') cands = cands.filter((c) => c.role === o.role);
  if (o.needsTools) cands = cands.filter((c) => c.tools);
  if (Number(o.minCtx) > 0) cands = cands.filter((c) => c.ctx === 0 || c.ctx >= Number(o.minCtx)); // unknown ctx not excluded
  if (localOnly) cands = cands.filter((c) => c.local);
  const considered = cands.length;
  if (!considered) return { pick: null, frontier: [], considered: 0, priority, weights: w, why: 'no provider matched the filter (' + JSON.stringify({ role: o.role || null, needsTools: !!o.needsTools, minCtx: Number(o.minCtx) || null, localOnly }) + ').' };

  const ranked = cands.map((c) => ({ c, s: score(c, w) }))
    .sort((a, b) => (b.s - a.s) || ((b.c.verified ? 1 : 0) - (a.c.verified ? 1 : 0)) || ((a.c.proxy === 'none' ? 1 : 0) - (b.c.proxy === 'none' ? 1 : 0)));
  const pick = ranked[0].c;
  const frontier = pareto(cands);
  return { pick, frontier, considered, priority, weights: w, why: explain(pick, priority, o, providers) };
}

const TIER = (n) => (n > 0 ? n + '/5' : 'unknown');
function explain(c, priority, o, providers) {
  const lead = { cost: 'cheapest', speed: 'fastest', quality: 'most capable', balanced: 'best-balanced', privacy: 'best local (nothing leaves the machine)' }[priority];
  const bits = [c.label + ': the ' + lead + ' option' + (o && o.needsTools ? ' with tool support' : '') + (Number(o && o.minCtx) > 0 ? ' meeting context >= ' + o.minCtx : '') + '.'];
  bits.push('Tiers: cost ' + TIER(c.cost) + ', speed ' + TIER(c.speed) + ', quality ' + TIER(c.quality) + ' (indicative, not a benchmark).');
  if (!c.cost || !c.speed || !c.quality) bits.push('Some tiers are unknown for this provider, so the pick is partly estimated.');
  if (c.local) bits.push('Local: runs on your own hardware, $0, air-gapped, but weaker and slower than Claude.');
  else if (c.proxy && c.proxy !== 'none') bits.push('Runs on your own key via a translating proxy; confirm the base URL before switching.');
  // honest nudge toward the flat-rate default when routing for cost off-subscription
  const claude = (providers || []).find((p) => p && p.flatRate);
  if (priority === 'cost' && claude && c.providerId !== claude.id) bits.push('If you are on the Claude subscription, ' + (claude.label || 'Claude') + ' is $0 marginal and may be cheaper in practice than any per-token provider.');
  if (!c.verified) bits.push('Not endpoint-verified at research time; the switch preview shows the exact target first.');
  return bits.join(' ');
}

module.exports = { candidates, pareto, dominates, score, route, WEIGHTS, PRIORITIES };
