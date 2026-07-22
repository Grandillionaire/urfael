'use strict';
// claude.js — the SAME offline stub, reachable on hosts that cannot exec a shebang script (native Windows).
// require() strips the #! line, so this simply runs ./claude under whatever node invoked us; the smoke test
// points URFAEL_CLAUDE_BIN here on win32 and app/claude-bin.js's .js branch runs it via process.execPath.
require('./claude');
