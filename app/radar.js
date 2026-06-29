'use strict';
// app/radar.js — the competitor radar. Watches rival self-hosted agents (Hermes, OpenClaw) for new releases and,
// when they ship, runs the same honest analysis a human would: what did they ship, do we already do it (often
// better), does it fit Urfael's principles, is it worth borrowing, and how to do it in our zero-dep style. It
// produces a REPORT for the owner to review and approve, and it NEVER implements or ships anything on its own.
// Zero-dep: gh for the GitHub reads, the claude CLI (Urfael's own brain) for the analysis, plain files for state.
// The pure pieces (which releases are new, the prompt, the report) are unit-tested; the I/O is a thin, fail-soft shell.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const CONFIG = path.join(JDIR, 'radar.json');
const STATE = path.join(JDIR, 'radar-state.json');
const REPORT_DIR = path.join(JDIR, 'radar');
const DEFAULT_REPOS = ['NousResearch/hermes-agent', 'openclaw/openclaw'];

const PRINCIPLES = `URFAEL'S NON-NEGOTIABLE PRINCIPLES (a borrow that violates one is a SKIP, or must be re-implemented to fit):
- NO inbound network port, ever (a 0600 unix socket only).
- ZERO runtime dependencies (Node stdlib only).
- Fortress by default: no network egress on untrusted/remote turns; a credential-deny boundary.
- Honesty: never overclaim; ship with caveats.
- Local-first and sovereign: runs on the owner's machine, no hosted service, no phone-home.
Both rivals are MIT-licensed, so borrowing CODE is legal with attribution; borrowing IDEAS is always fine. Prefer re-implementing the idea tiny and dependency-free over lifting code.`;

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────
function defaultConfig() { return { repos: DEFAULT_REPOS.slice(), perRunMax: 5 }; }

// releases come newest-first. lastTag = the newest tag we analyzed last time. First run returns just the latest
// (a baseline sample); after that, everything strictly newer than lastTag, capped so a long gap can't flood.
function newReleases(releases, lastTag, cap) {
  const list = Array.isArray(releases) ? releases.filter((r) => r && r.tagName) : [];
  const max = cap || 5;
  if (!lastTag) return list.slice(0, 1);
  const i = list.findIndex((r) => r.tagName === lastTag);
  return (i < 0 ? list.slice(0, max) : list.slice(0, i)).slice(0, max);
}

function buildAnalysisPrompt(repo, release, urfaelMap) {
  return [
    "You are Urfael's competitor radar. A rival self-hosted AI agent just shipped a release. Decide, honestly,",
    "whether anything in it is worth borrowing for Urfael, and if so, how to do it in Urfael's style.", '',
    PRINCIPLES, '',
    'WHAT URFAEL ALREADY IS (its competitive map; check claims against this, do not assume we lack something):',
    String(urfaelMap || '(map unavailable)').slice(0, 12000), '',
    'THE NEW RELEASE, ' + repo + ' ' + release.tagName + ' (' + (release.name || '') + ', ' + (release.publishedAt || '') + '):',
    String(release.body || '(no release notes)').slice(0, 8000), '',
    'Produce a concise markdown analysis with exactly these sections:',
    '1. What they shipped (the substantive new capabilities; ignore version-bump and chore noise).',
    '2. Do we already have it? (and do we do it better? be specific; often we may already win.)',
    '3. Worth borrowing? For each candidate: fit with our principles (name any veto), value (high/med/low),',
    '   effort (S/M/L), and a recommendation (borrow-idea / adapt / skip).',
    '4. Implementation sketch for anything you recommend, in Urfael zero-dep style, naming the files it touches.',
    'Be honest and terse. If there is nothing worth taking, say so plainly. Never recommend anything that violates',
    'a principle. House style: no em dashes or en dashes.',
    'Output ONLY the four numbered sections as markdown, starting at section 1. Do not add a preamble, a top-level',
    'title, or restate the release header (it is already printed above your output).',
  ].join('\n');
}

function assembleReport(items, stamp) {
  const out = [
    '# Urfael competitor radar, ' + stamp, '',
    'Autonomous analysis of new rival releases. Nothing here has been implemented or shipped: this is a proposal',
    'for you to review and approve. Approve the worthwhile items and I will implement them in our zero-dep style.', '',
  ];
  for (const it of items) {
    out.push('---', '', '## ' + it.repo + ' ' + it.rel.tagName + (it.rel.name ? ' (' + it.rel.name + ')' : ''));
    if (it.rel.publishedAt) out.push('_shipped ' + it.rel.publishedAt + '_');
    out.push('', String(it.analysis || '(analysis failed)').trim(), '');
  }
  return out.join('\n');
}

// ── thin I/O (async, fail-soft, never blocks the daemon) ────────────────────────────────────────────────────
function readJSON(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }
function loadConfig() { const c = readJSON(CONFIG, null); return c && Array.isArray(c.repos) && c.repos.length ? { perRunMax: 5, ...c } : defaultConfig(); }
function loadState() { return readJSON(STATE, {}); }
function saveState(s) { try { fs.mkdirSync(JDIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 }); } catch {} }
function readMap() { for (const f of ['PARITY.md', 'README.md']) { try { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); } catch {} } return ''; }

function sh(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '', done = false, p;
    const fin = () => { if (!done) { done = true; resolve(out); } };
    try { p = spawn(bin, args, { env: opts.env || process.env, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(''); }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} fin(); }, opts.timeout || 120000);
    p.stdout.on('data', (d) => { out += d; if (out.length > (opts.cap || (1 << 20))) { try { p.kill(); } catch {} } });
    p.on('error', () => { clearTimeout(timer); fin(); });
    p.on('exit', () => { clearTimeout(timer); fin(); });
  });
}

async function fetchReleases(repo, limit) {
  const out = await sh('gh', ['release', 'list', '--repo', repo, '--limit', String(limit || 10), '--json', 'tagName,name,publishedAt'], { timeout: 30000 });
  try { const j = JSON.parse(out); return Array.isArray(j) ? j : []; } catch { return []; }
}
async function fetchBody(repo, tag) {
  const out = await sh('gh', ['release', 'view', tag, '--repo', repo, '--json', 'body'], { timeout: 30000 });
  try { return String(JSON.parse(out).body || ''); } catch { return ''; }
}
// Release notes are UNTRUSTED external content (a prompt-injection vector), so spawn the brain hardened the
// same way the daemon's stateless untrusted handler does: --strict-mcp-config (no ambient MCP servers — this
// also stops a hang when a configured server, e.g. a claude.ai connector, blocks on interactive auth), no
// tools at all (--allowedTools '' — the notes can not make it act), a non-interactive permission mode (never
// stalls waiting on a prompt with no TTY), and a pinned fast model. We also strip the parent Claude Code
// session markers so a nested `claude -p` (radar run by hand from inside a Claude session) starts a fresh
// headless session instead of trying to attach to ours and hanging.
const NESTED_CLAUDE_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT'];
function brainEnv(env) { const e = { ...(env || process.env) }; for (const k of NESTED_CLAUDE_ENV) delete e[k]; return e; }
function analyzeArgs(prompt) { return ['-p', prompt, '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--allowedTools', '']; }
async function analyze(prompt, claudeBin, env) {
  if (!claudeBin) return '';
  return (await sh(claudeBin, analyzeArgs(prompt), { env: brainEnv(env), timeout: 240000 })).trim();
}

// run({ claudeBin, env, now }) → { analyzed, reportPath, repos }. The whole pass, fail-soft (never throws).
async function run(opts = {}) {
  const now = opts.now || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cfg = loadConfig();
  const state = loadState();
  const map = readMap();
  const items = [];
  for (const repo of cfg.repos) {
    const releases = await fetchReleases(repo, 10);
    if (!releases.length) continue;                            // gh missing/unauthed, or no releases: skip, do not crash
    for (const rel of newReleases(releases, state[repo], cfg.perRunMax)) {
      const body = await fetchBody(repo, rel.tagName);
      const analysis = await analyze(buildAnalysisPrompt(repo, { ...rel, body }, map), opts.claudeBin, opts.env);
      items.push({ repo, rel, analysis });
    }
    state[repo] = releases[0].tagName;                         // advance the baseline to the newest seen
  }
  saveState(state);
  if (!items.length) return { analyzed: 0, reportPath: null, repos: cfg.repos };
  let reportPath = null;
  try { fs.mkdirSync(REPORT_DIR, { recursive: true }); reportPath = path.join(REPORT_DIR, now + '.md'); fs.writeFileSync(reportPath, assembleReport(items, now), { mode: 0o600 }); } catch {}
  return { analyzed: items.length, reportPath, repos: cfg.repos };
}

module.exports = { run, newReleases, buildAnalysisPrompt, assembleReport, defaultConfig, loadConfig, loadState, saveState, fetchReleases, analyzeArgs, brainEnv, NESTED_CLAUDE_ENV, PRINCIPLES, DEFAULT_REPOS, CONFIG, STATE, REPORT_DIR };
