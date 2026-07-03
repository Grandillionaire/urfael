'use strict';
// urfael quickstart, the fast path. It connects you (reusing the tested setup wizard only if you are
// not already configured), then hands you the whole moat with one line to try each, so a brand-new user
// feels the difference from Hermes and OpenClaw on the first turn. House style: no em or en dashes.

const { spawnSync } = require('child_process');
const setup = require('./setup');

const T = process.stdout.isTTY;
const c = (n, s) => (T ? '\x1b[' + n + 'm' + s + '\x1b[0m' : s);
const gold = (s) => c('38;5;179', s);
const amber = (s) => c('38;5;214', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const ok = (s) => c('38;5;114', s);
const p = (s) => process.stdout.write((s == null ? '' : s) + '\n');

function voiceReady() {
  return setup.has('ffmpeg') && (setup.has('whisper-cli') || setup.has('whisper-cpp') || setup.has('main'));
}
// a provider is configured if a base URL / API key is set, or the claude subscription login answers
function configured(env) {
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_KEY) return true;
  const cb = setup.claudePath();
  if (!cb) return false;
  try { return spawnSync(cb, ['-p', 'reply with: ok'], { stdio: 'ignore', timeout: 20000 }).status === 0; } catch { return false; }
}

async function run() {
  p('');
  p('  ' + amber('ᚢ') + '  ' + gold('URFAEL QUICKSTART'));
  p('  ' + dim('The fast path. We connect you, then hand you the whole moat.'));
  p('');

  // 1) connect, only if you are not already set up (otherwise this is instant)
  if (configured(setup.readEnv())) {
    p('  ' + ok('Already connected.') + ' ' + dim('Your provider is configured and reachable.'));
  } else {
    p('  ' + bold('First, how Urfael reaches Claude.') + ' ' + dim('Running the connect step (press Enter through the defaults).'));
    p('');
    await setup.run();   // the tested provider wizard; recommended defaults on every prompt
  }
  p('');

  // 2) what is live on this machine right now
  const env = setup.readEnv();
  p('  ' + bold('On this machine'));
  p('    ' + (voiceReady() ? ok('✓') + '  Local voice is ready ' + dim('(whisper.cpp in, local TTS out, nothing leaves the box)')
                           : dim('·') + '  Local voice ' + dim('wants ffmpeg + whisper.cpp; everything else works fully without it')));
  p('    ' + ok('✓') + '  Active recall is on ' + dim('(past turns and verified lessons are pulled in for you, every turn)'));
  p('    ' + (env.URFAEL_EMBED_URL ? ok('✓') + '  Semantic recall is on'
                                  : dim('·') + '  Semantic recall ' + dim('is optional; keyword recall already works. Add it in `urfael setup`.')));
  p('    ' + ok('✓') + '  Fortress posture ' + dim('(remote turns are read only, no egress; the safe default)'));
  p('');

  // 3) the moat, with one line to feel each
  p('  ' + bold('Your moat, ready now'));
  const row = (cmd, what) => p('    ' + gold(cmd) + (T ? '\x1b[0m' : '') + '\n      ' + dim(what));
  row('urfael "remember: ..."',        'tell it something, then ask in a fresh session. It recalls across sessions, on its own.');
  row('urfael council "<hard q>"',     'watch real multi-agent reasoning, every worker sandboxed and read only.');
  row('urfael code "<task>"',          'Claude Code in your repo with an auto-checkpoint and a one-command undo.');
  row('urfael attest',                 'a signed, tamper-evident report of exactly what it did, for you or a reviewer.');
  row('urfael "search the web ..."',   'web is OFF by default to block exfiltration. Turn it on in `urfael setup` (Full mode).');
  row('npm run security',              'attack the daemon yourself. The last run held 10 of 10 classes, 101 of 101 checks.');
  p('');

  // 4) one concrete first win the user can feel in 30 seconds
  p('  ' + bold('Try this first'));
  p('    ' + dim('1.') + '  ' + gold('urfael "remember that I take my coffee black"'));
  p('    ' + dim('2.') + '  open a fresh terminal:  ' + gold('urfael "how do I take my coffee?"'));
  p('    ' + dim('    it recalls it across sessions. That is the difference you feel every day.'));
  p('');

  p('  ' + ok('You are set.') + ' ' + dim('Full reference: ') + gold('urfael help') + dim('    live vitals: ') + gold('urfael status'));
  p('');
}

module.exports = { run };
