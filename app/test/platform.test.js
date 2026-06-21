'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const plat = require('../platform');

const TERMUX = { PREFIX: '/data/data/com.termux/files/usr', HOME: '/data/data/com.termux/files/home' };

test('detect identifies each host from env + process.platform', () => {
  assert.equal(plat.detect(TERMUX, 'linux').kind, 'termux');
  assert.equal(plat.detect({}, 'darwin').kind, 'macos');
  assert.equal(plat.detect({}, 'win32').kind, 'windows');
  assert.equal(plat.detect({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux').kind, 'wsl');
  assert.equal(plat.detect({}, 'linux').kind, 'linux');
});

test('Termux is mobile, has no Docker, and gains SMS/telephony capabilities', () => {
  const t = plat.detect(TERMUX, 'linux');
  assert.equal(t.isTermux, true);
  assert.equal(t.isMobile, true);
  assert.equal(t.hasDocker, false);                 // no Docker on Android
  assert.equal(t.caps.sms, true);
  assert.equal(t.caps.telephony, true);
  assert.equal(t.caps.desktopNotify, false);
  // a desktop host has Docker and no SMS
  const m = plat.detect({}, 'darwin');
  assert.equal(m.hasDocker, true);
  assert.equal(m.caps.sms, false);
});

test('notify/speak return an injection-safe argv per platform', () => {
  const t = plat.detect(TERMUX, 'linux').notify('Urfael', 'hi');
  assert.equal(t.cmd, 'termux-notification');
  assert.ok(Array.isArray(t.args) && t.args.includes('hi'));            // the body is its OWN argv element, never a shell string
  assert.equal(plat.detect(TERMUX, 'linux').speak('hello').cmd, 'termux-tts-speak');
  assert.equal(plat.detect({}, 'darwin').speak('hi').cmd, 'say');
  assert.equal(plat.detect({}, 'linux').speak('hi').cmd, 'espeak-ng');
  assert.equal(plat.detect({}, 'linux').notify('t', 'b').cmd, 'notify-send');
  // a hostile body stays a single argv element (no shell), and is length-bounded
  const evil = plat.detect({}, 'linux').notify('t', '"; rm -rf ~ #'.repeat(100));
  assert.ok(Array.isArray(evil.args) && evil.args[1].length <= 500);
});
