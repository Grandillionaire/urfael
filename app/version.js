'use strict';
// app/version.js — semver parse + compare for `urfael version` / `urfael update`. PURE, no I/O, never throws.
// Closes a real gap (Hermes ships tagged releases; Urfael shipped no version discipline). The CLI does the git I/O.

function parse(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

// compare(a, b) → -1 / 0 / 1 (a<b / a==b / a>b). An unparseable side compares as equal (0), so a bad input is inert.
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  const d = (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}
function isNewer(a, b) { return compare(a, b) > 0; }   // is a strictly newer than b?

module.exports = { parse, compare, isNewer };
