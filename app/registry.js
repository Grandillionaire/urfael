'use strict';
// app/registry.js — the single source of truth for the entire CLI surface.
// Pure data + a resolver + three pure renderers. No handler logic lives here; the
// dispatcher in cli.js owns behaviour. cli.js derives its did-you-mean keyword list AND
// every word of help text from THIS file, so the old hand-maintained command array and
// the //-comment self-scrape are both gone and can never drift from the real command graph.
//
// Honesty rule for `summary`: it states what the handler ACTUALLY does, never what it
// would be nice if it did — verified line-by-line against cli.js dispatch branches.
//
// Each command:
//   name        canonical verb (must have a live dispatch branch in cli.js, except `ask`)
//   group       one of GROUPS' keys — where it appears in `urfael help`
//   summary     one quiet, dry line; under-claims rather than over-claims
//   usage       real signature: real subcommands + real flags only
//   examples    1-3 copy-pasteable REAL invocations
//   see         (optional) related canonical names → a "related:" line in `help <cmd>`
//   aliases     (optional) real handler aliases — fed ONLY to did-you-mean, never shown
//   starter     true → shown on the bare `urfael` "start here" card (first-use only)
//   bareLabel   (starter, optional) the exact left-column invocation on the bare card
//   bareSummary (starter, optional) a terser summary for the bare card (full one elsewhere)
//   hidden      true → folded under a parent command, never given its own help row

// Ordered groups. The value is the plain gold section label shown in `urfael help`.
// No per-group rune glyphs — those would be invented meaning (the codebase uses runes
// only for the ᚢᚱᚠᚨᛖᛚ wordmark and ᚦ for fortress mode). Plain labels only.
const GROUPS = {
  ASK:      'ASK      put a question to it',
  MEMORY:   'MEMORY   what it knows about you, and where each belief came from',
  SCHEDULE: 'SCHEDULE reminders, background jobs, and cron',
  TEAM:     'TEAM     the roster, the activity trail, the seal',
  SKILLS:   'SKILLS   install and share skills (scanned, never executed)',
  CONNECT:  'CONNECT  optional integrations via MCP — previewed, owner turns only',
  PLUGINS:  'PLUGINS  capability-scoped, sandboxed, signed extensions',
  SERVE:    'SERVE    expose the brain — API, web console, webhooks',
  SYSTEM:   'SYSTEM   setup, health, and the daemon',
};

const COMMANDS = [
  // ── ASK ──────────────────────────────────────────────────────────────────────
  { name: 'ask', group: 'ASK', starter: true, bareLabel: 'urfael "<anything>"', bareSummary: 'ask it — the answer streams back',
    summary: 'ask anything — the default verb; streams the answer live',
    usage: 'urfael "<your question>"',
    examples: ['urfael "what\'s on my calendar today?"', 'urfael "summarise the thread with Stefan and draft a reply"'],
    see: ['sessions', 'stop'] },
  { name: 'sessions', group: 'ASK', starter: true, bareLabel: 'urfael sessions search …', bareSummary: 'search every past conversation',
    summary: 'full-text search of every past conversation',
    usage: 'urfael sessions search <query>',
    examples: ['urfael sessions search "railway token"', 'urfael sessions search invoice'],
    see: ['why'] },
  { name: 'stop', group: 'ASK',
    summary: 'abort the current in-flight turn (or Ctrl+C while it answers)',
    usage: 'urfael stop', examples: ['urfael stop'], see: ['shutdown'] },

  // ── MEMORY ───────────────────────────────────────────────────────────────────
  { name: 'why', group: 'MEMORY',
    summary: 'trace a belief to the commit that set it — a checkable SHA',
    usage: 'urfael why "<a belief or fact you want sourced>"',
    examples: ['urfael why "prefers terse replies"', 'urfael why "Co-CEO of MYG Media"'],
    see: ['drift', 'as-of', 'learn'] },
  { name: 'drift', group: 'MEMORY',
    summary: 'how the model of you changed — added / revised / removed',
    usage: 'urfael drift [file] [--since <date>]',
    examples: ['urfael drift', 'urfael drift MEMORY.md --since "2026-05-01"'],
    see: ['why', 'as-of'] },
  { name: 'as-of', group: 'MEMORY', aliases: ['asof'],
    summary: 'reconstruct a memory file as of a past date (def USER.md)',
    usage: 'urfael as-of <date> [file]',
    examples: ['urfael as-of "2026-05-01"', 'urfael as-of "2026-05-01" MEMORY.md'],
    see: ['drift', 'why'] },
  { name: 'learn', group: 'MEMORY',
    summary: 'the learning ledger — learned, verified, pruned, w/ confidence',
    usage: 'urfael learn [trusted|proposed|retired]',
    examples: ['urfael learn', 'urfael learn trusted'], see: ['why', 'forget'] },
  { name: 'forget', group: 'MEMORY',
    summary: 'remove matching beliefs + leave a provable git tombstone',
    usage: 'urfael forget ["<phrase>"]',
    examples: ['urfael forget "old office address"', 'urfael forget'], see: ['learn', 'why'] },

  // ── SCHEDULE ─────────────────────────────────────────────────────────────────
  { name: 'remind', group: 'SCHEDULE', starter: true, bareLabel: 'urfael remind …', bareSummary: 'set a reminder, once or repeating',
    summary: 'set a reminder, once or repeating',
    usage: 'urfael remind "<text>" (--in <mins> | --at <iso>)\n  [--repeat daily|weekly|<mins> | --days <list> | --cron <expr>]',
    examples: ['urfael remind "call the dentist" --in 20', 'urfael remind "standup" --at "2026-06-19T09:30" --repeat weekly'],
    see: ['reminders', 'cron'] },
  { name: 'reminders', group: 'SCHEDULE',
    summary: 'list scheduled reminders', usage: 'urfael reminders',
    examples: ['urfael reminders'], see: ['remind'] },
  { name: 'jobs', group: 'SCHEDULE',
    summary: 'list background jobs and their state',
    usage: 'urfael jobs | job <id> | cancel <id>',
    examples: ['urfael jobs', 'urfael job a1b2c3', 'urfael cancel a1b2c3'], see: ['cron'] },
  { name: 'job', group: 'SCHEDULE', hidden: true,
    summary: 'inspect one background job (full record + log tail)',
    usage: 'urfael job <id>', examples: ['urfael job a1b2c3'], see: ['jobs'] },
  { name: 'cancel', group: 'SCHEDULE', hidden: true,
    summary: 'cancel a background job by id',
    usage: 'urfael cancel <id>', examples: ['urfael cancel a1b2c3'], see: ['jobs'] },
  { name: 'cron', group: 'SCHEDULE',
    summary: 'run the brain (or a --script shell cmd) on a schedule',
    usage: 'urfael cron add "<prompt>" (--cron <expr> | --days <list> --at HH:MM |\n  --daily-at HH:MM | --in N | --repeat daily) [--then "<prompt>"]\n  [--script "<cmd>"] [--deliver notify|silent|push]\nurfael cron list | cancel <id> | run <id>',
    examples: ['urfael cron add "brief me on overnight email" --daily-at 07:30', 'urfael cron add "poll the deploy" --cron "*/15 9-17 * * 1-5"', 'urfael cron list'],
    see: ['remind', 'jobs', 'script'] },

  // ── TEAM ─────────────────────────────────────────────────────────────────────
  { name: 'team', group: 'TEAM',
    summary: 'manage the roster; `pair` mints a single-use guest code',
    usage: 'urfael team [add <channel> <id> [name] [owner|member|guest]\n  | remove <channel> <id> | pair [channel] [--ttl <mins>]]',
    examples: ['urfael team', 'urfael team add telegram 12345 "Sam" member', 'urfael team pair telegram --ttl 60'],
    see: ['audit', 'seal'] },
  { name: 'audit', group: 'TEAM',
    summary: 'team activity trail; --verify walks the Ledger of Record',
    usage: 'urfael audit [--json | --verify]',
    examples: ['urfael audit', 'urfael audit --verify'], see: ['seal', 'team'] },
  { name: 'seal', group: 'TEAM',
    summary: 'owner ed25519 key signs the ledger head — attests, not proves',
    usage: 'urfael seal [--verify]',
    examples: ['urfael seal', 'urfael seal --verify'], see: ['audit'] },

  // ── SKILLS ───────────────────────────────────────────────────────────────────
  { name: 'skills', group: 'SKILLS', starter: true, bareLabel: 'urfael skills list', bareSummary: 'your skills (scanned, never run)',
    summary: 'your installed skills; install scans + previews, never runs',
    usage: 'urfael skills list | export <name> | scan <file>\n  | install <https-url> [--yes]',
    examples: ['urfael skills list', 'urfael skills install https://example.com/skill.md', 'urfael skills scan ./draft.md'],
    see: ['hub', 'import'] },
  { name: 'hub', group: 'SKILLS',
    summary: 'browse the skill registry — scanned + sha-checked, never run',
    usage: 'urfael hub [search <term>] | install <slug> [--yes] | publish <file>',
    examples: ['urfael hub', 'urfael hub search calendar', 'urfael hub install daily-brief'],
    see: ['skills'] },
  { name: 'import', group: 'SKILLS',
    summary: 'migrate memory + skills from OpenClaw/Hermes (dry-run default)',
    usage: 'urfael import [--from openclaw|hermes] [--path <dir>] [--apply]',
    examples: ['urfael import --from hermes', 'urfael import --from openclaw --apply'], see: ['skills'] },

  // ── CONNECT ──────────────────────────────────────────────────────────────────
  { name: 'connect', group: 'CONNECT', aliases: ['connectors', 'connector', 'integration', 'integrations', 'mcp'],
    summary: 'add MCP connectors — previewed, scanned, secrets masked',
    usage: 'urfael connect [search <term>] | info <id> | add <id> | remove <id> | installed',
    examples: ['urfael connect', 'urfael connect search calendar', 'urfael connect add github'],
    see: ['skills', 'hub'] },

  // ── PLUGINS ──────────────────────────────────────────────────────────────────
  { name: 'plugin', group: 'PLUGINS', aliases: ['plugins'],
    summary: 'install, enable, scan + inspect sandboxed MCP plugins',
    usage: 'urfael plugin [list | scan <file> | info <file> | install <file>\n  | enable <id> | disable <id> | secret <REF>]',
    examples: ['urfael plugin list', 'urfael plugin scan ./plugin.json', 'urfael plugin install ./plugin.json'],
    see: ['connect', 'skills'] },

  // ── SERVE ────────────────────────────────────────────────────────────────────
  { name: 'serve', group: 'SERVE',
    summary: 'OpenAI-compatible local API (localhost only, token-gated)',
    usage: 'urfael serve [--token]',
    examples: ['urfael serve', 'urfael serve --token'], see: ['dashboard', 'hooks'] },
  { name: 'dashboard', group: 'SERVE',
    summary: 'open the token-gated localhost web console (prints the URL)',
    usage: 'urfael dashboard', examples: ['urfael dashboard'], see: ['serve', 'tui'] },
  { name: 'tui', group: 'SERVE',
    summary: 'full-screen terminal cockpit — turns, scrollback, status',
    usage: 'urfael tui', examples: ['urfael tui'], see: ['dashboard', 'status'] },
  { name: 'council', group: 'SERVE',
    summary: 'live multi-agent council — watch agents decompose + synthesize',
    usage: 'urfael council "<task>" [--agents N]\nurfael council --list | --replay <id>',
    examples: ['urfael council "audit this repo for security gaps"', 'urfael council "compare 3 caching strategies" --agents 4', 'urfael council --list'],
    see: ['tui', 'jobs'] },
  { name: 'hooks', group: 'SERVE',
    summary: 'start the loopback webhook receiver + print its URL',
    usage: 'urfael hooks', examples: ['urfael hooks'], see: ['hook'] },
  { name: 'hook', group: 'SERVE',
    summary: 'register / list / remove webhook triggers; relay = two-way',
    usage: 'urfael hook add "<name>" [--action ask|notify|relay]\n  [--reply-url <url> --reply-auth <hdr>] [--deliver notify|silent|push]\nurfael hook list | rm <id>',
    examples: ['urfael hook add "deploy finished" --action notify', 'urfael hook list'], see: ['hooks'] },
  { name: 'script', group: 'SERVE',
    summary: 'saved-script library; needs URFAEL_SCRIPT_CRON=1',
    usage: 'urfael script add <name> "<shell>" | run <name> [args…] | list | rm <name>',
    examples: ['urfael script add backup "tar czf ~/bak.tgz ~/work"', 'urfael script run backup'], see: ['cron'] },

  // ── SYSTEM ───────────────────────────────────────────────────────────────────
  { name: 'setup', group: 'SYSTEM', starter: true, aliases: ['init', 'onboard'], bareSummary: 'onboarding — auth + provider',
    summary: 'onboarding wizard — pick subscription / API key / local model',
    usage: 'urfael setup', examples: ['urfael setup'], see: ['doctor', 'status'] },
  { name: 'status', group: 'SYSTEM', starter: true, bareSummary: 'the Hearth — a live vitals card',
    summary: 'the Hearth — model, 7-day tokens, facts, seal, uptime',
    usage: 'urfael status', examples: ['urfael status'], see: ['doctor', 'tui', 'model'] },
  { name: 'model', group: 'SYSTEM',
    summary: 'pin the model (opus / sonnet / auto) — or just ask in chat',
    usage: 'urfael model [opus | sonnet | auto]',
    examples: ['urfael model', 'urfael model opus', 'urfael model auto'], see: ['status', 'persona'] },
  { name: 'persona', group: 'SYSTEM',
    summary: 'switch voice — architect/sage/operator/muse/analyst (or ask)',
    usage: 'urfael persona [<id> | list | reset]',
    examples: ['urfael persona', 'urfael persona architect', 'urfael persona reset'], see: ['model', 'status'] },
  { name: 'doctor', group: 'SYSTEM', starter: true, bareSummary: 'health read; every issue carries its fix',
    summary: 'health read; every red line carries its own one-command fix',
    usage: 'urfael doctor', examples: ['urfael doctor'], see: ['status', 'setup'] },
  { name: 'health', group: 'SYSTEM',
    summary: 'print the daemon health JSON',
    usage: 'urfael health', examples: ['urfael health'], see: ['doctor', 'shutdown'] },
  { name: 'shutdown', group: 'SYSTEM',
    summary: 'stop the daemon — distinct from `stop` (aborts one turn)',
    usage: 'urfael shutdown', examples: ['urfael shutdown'], see: ['stop', 'health'] },
  { name: 'logo', group: 'SYSTEM',
    summary: 'print the Urfael terminal logo',
    usage: 'urfael logo', examples: ['urfael logo'] },
  { name: 'help', group: 'SYSTEM',
    summary: 'this reference; `help <command>` drills into one command',
    usage: 'urfael help [command]', examples: ['urfael help', 'urfael help cron'] },
];

// alias → canonical, built from each entry's `aliases`. Real handler aliases only; fed
// to byName()/did-you-mean, rendered in no help tier.
const ALIASES = {};
for (const c of COMMANDS) for (const a of (c.aliases || [])) ALIASES[a] = c.name;

// Resolve a name OR a real alias to its registry entry. Powers `help <cmd>`.
function byName(name) {
  const n = String(name || '').toLowerCase();
  return COMMANDS.find((c) => c.name === (ALIASES[n] || n)) || null;
}

// ── pure renderers (built on cli.js's frame()/banner()/gold/dim/visLen via the `ui` bag,
//    so this module stays dependency-free and testable; each returns a STRING) ──────────
const pad = (s, w, ui) => ' '.repeat(Math.max(0, w - ui.visLen(s)));
const visible = () => COMMANDS.filter((c) => !c.hidden);

// tier 1 — bare `urfael`: a short "start here" card. Line one is the first move (asking is
// the default verb and the product). Then the starters, then an HONEST overflow count.
function renderBare(ui) {
  const { banner, frame, gold, dim } = ui;
  const starters = COMMANDS.filter((c) => c.starter);
  const label = (c) => c.bareLabel || ('urfael ' + c.name);
  const W = Math.max(...starters.map((c) => ui.visLen(label(c))));
  const row = (c) => gold(label(c)) + pad(label(c), W, ui) + dim('  ' + (c.bareSummary || c.summary));
  const overflow = COMMANDS.filter((c) => !c.hidden && c.name !== 'help' && !c.starter).length;
  const ask = starters.find((c) => c.name === 'ask');
  const lines = [row(ask), ''];
  for (const c of starters) if (c.name !== 'ask') lines.push(row(c));
  lines.push('', dim('and ' + overflow + ' more — the full reference:  ') + gold('urfael help'));
  return banner() + '\n' + frame('start here', lines);
}

// tier 2 — `urfael help`: the FULL reference, GROUPED, one frame() per group. All boxes
// share one inner width so the stack reads as a deliberate set, never a ragged wall.
function renderFull(ui) {
  const { banner, frame, gold, dim } = ui;
  const blocks = [];
  let inner = 46;
  for (const key of Object.keys(GROUPS)) {
    const cmds = COMMANDS.filter((c) => c.group === key && !c.hidden);
    if (!cmds.length) continue;
    const W = Math.max(...cmds.map((c) => ui.visLen(c.name)));
    const rows = cmds.map((c) => gold(c.name) + pad(c.name, W, ui) + dim('  ' + c.summary));
    inner = Math.max(inner, ui.visLen(GROUPS[key]) + 4, ...rows.map((r) => ui.visLen(r) + 2));
    blocks.push({ key, rows });
  }
  const out = [banner()];
  for (const b of blocks) out.push(frame(GROUPS[b.key], b.rows, inner));
  out.push(dim('one command in depth:  ') + gold('urfael help <command>') + dim('     ·     ' + visible().length + ' commands'));
  return out.join('\n');
}

// tier 3 — `urfael help <command>`: one command in focus. Honest summary + real usage +
// 1-3 copy-pasteable examples + a see-also line. Resolves real aliases via byName().
function renderOne(name, ui) {
  const { frame, gold, dim } = ui;
  const c = byName(name);
  if (!c) {
    const g = nearest(name);
    const lines = [dim('no command  ') + gold(String(name))];
    if (g) lines.push('', dim('did you mean  ') + gold('urfael help ' + g) + dim('  ?'));
    lines.push('', dim('the full list:  ') + gold('urfael help'));
    return frame('unknown command', lines);
  }
  const usage = String(c.usage).split('\n').map((u) => '  ' + gold(u));   // long usages are pre-wrapped to stay ≤80 cols
  const lines = [dim(c.summary), '', dim('usage'), ...usage, '', dim('examples'), ...c.examples.map((e) => '  ' + gold(e))];
  if (c.see && c.see.length) lines.push('', dim('related:  ') + c.see.map((s) => gold('urfael ' + s)).join(dim('   ')));
  return frame('urfael ' + c.name, lines);
}

// closest registry NAME for an unknown `help <bad>`. Looser than did-you-mean (≤2): the
// user already typed `help`, so the intent to find a command is clear — a generous nudge.
let _ed = null;
function nearest(word) {
  if (typeof _ed !== 'function') return '';
  const w = String(word || '').toLowerCase();
  let best = '', bd = Infinity;
  for (const c of COMMANDS) { if (c.hidden) continue; const d = _ed(w, c.name); if (d < bd) { bd = d; best = c.name; } }
  return bd <= 2 ? best : '';
}

module.exports = {
  GROUPS, COMMANDS, ALIASES, byName, renderBare, renderFull, renderOne,
  set editDistance(fn) { _ed = fn; },   // cli.js injects lib.editDistance for nearest()
};
