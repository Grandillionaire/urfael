'use strict';
// Shared test helper: assert a file is "owner-only" in the way the RUNNING platform can express it.
// POSIX: the exact 0600 mode the module requested. win32: chmod is a near no-op (mode bits surface as 0666/0444),
// so demanding 0600 would assert something Windows cannot represent — there, the boundary is the profile ACL,
// and what remains testable is that the file exists where only the user's profile reaches. One helper so all
// nine call sites make the SAME statement instead of nine hand-rolled platform forks.
const fs = require('fs');
function assertOwnerOnly(assert, file, msg) {
  if (process.platform === 'win32') { assert.ok(fs.existsSync(file), msg + ' (exists; NTFS profile ACL is the owner-only boundary on win32)'); return; }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, msg);
}
module.exports = { assertOwnerOnly };
