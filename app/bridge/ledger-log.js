'use strict';
// Best-effort ledger POST for the opt-in goal-verify gate. Modeled on bridge/notify.js: node built-ins only, a
// single fixed destination (the owner's 0600 daemon socket → POST /goal/ledger), and NO way to redirect it. The
// verdict/contract is a LOG RECORD, never the control signal — so this must NEVER gate completion: a POST that
// fails (docker/ssh with no socket, daemon down, malformed) is a SILENT no-op that still exits 0. The daemon owns
// seq/prevH/hash on the tamper-evident ledger, so a child that curls this can pollute the log but cannot forge
// chain position or cause a false "done".
//   node ledger-log.js '<json>'
const client = require('../daemon-client');

const raw = process.argv.slice(2).join(' ');
let payload = null;
try { payload = JSON.parse(raw); } catch { payload = null; }

if (!payload || typeof payload !== 'object') { process.exit(0); } // nothing to log; never fail the loop
client.request('POST', '/goal/ledger', payload, { timeoutMs: 4000 })
  .then(() => process.exit(0))
  .catch(() => process.exit(0)); // socket unreachable / timeout / any error → silent no-op
