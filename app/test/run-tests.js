'use strict';
// test/run-tests.js — cross-platform launcher for the unit suite. `node --test test/*.test.js` depended on
// the SHELL expanding the glob: bash/zsh do, PowerShell/cmd do not, and node 20 does no globbing of its own —
// so the suite literally could not start on Windows. This enumerates test/*.test.js itself (sorted, so the
// order is stable everywhere) and hands node the explicit list; identical behavior on every OS + node ≥20.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
if (!files.length) { console.error('no *.test.js files found in ' + dir); process.exit(1); }
const r = spawnSync(process.execPath, ['--test'].concat(files), { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
