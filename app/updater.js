'use strict';
// updater.js — Urfael's own update check + (source-install) self-update. Zero deps (Node stdlib only).
//
// SECURITY POSTURE (self-updating code is the single most blast-radius-sensitive thing an agent can do):
//   - NEVER silent. The owner is notified and must confirm (the daemon's confirm gate); the brain can propose an
//     update but can never apply one on its own.
//   - A source-install update ONLY fast-forwards the EXISTING OFFICIAL remote (github.com/Grandillionaire/urfael).
//     A non-official origin is REFUSED. A dirty working tree is REFUSED. The brain cannot change the remote.
//   - The desktop app (no git checkout) is NOT self-updated here — a notarized in-app updater is required for that.
//     We only REPORT the new version + the official download URL. (Stub until electron-updater + notarization land.)
//   - All I/O is fail-soft: a network/git hiccup yields "no update info", never a throw, never a half-applied state.

const { execFile } = require('child_process');
const https = require('https');
const path = require('path');

const OFFICIAL = 'Grandillionaire/urfael';
const RELEASES_URL = 'https://github.com/' + OFFICIAL + '/releases/latest';

// ---- pure helpers (unit-tested) -----------------------------------------------------------------------------
// isOfficialRemote(url): TRUE only for the one official repo, in any of its https/ssh/git URL forms. Nothing else
// is updatable, so a fork or a brain-rewritten remote can never become a self-update source.
function isOfficialRemote(url) {
  if (typeof url !== 'string') return false;
  const u = url.trim().toLowerCase().replace(/\.git$/, '');
  return /(^|[/@.])github\.com[/:]grandillionaire\/urfael$/.test(u);
}

// compareVersions(a,b): -1 | 0 | 1. Tolerant of a leading 'v' and missing parts ('1.2' vs '1.2.0').
function compareVersions(a, b) {
  const norm = (s) => String(s == null ? '' : s).trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const x = norm(a), y = norm(b), len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// parseLatestTag(json): the tag_name out of a GitHub releases API object (string or parsed), or '' on anything odd.
function parseLatestTag(json) {
  try { const o = typeof json === 'string' ? JSON.parse(json) : json; return typeof (o && o.tag_name) === 'string' ? o.tag_name : ''; }
  catch { return ''; }
}

// summarize(status): the one-line owner notification, or '' when nothing is available.
function summarize(s) {
  if (!s || !s.available) return '';
  if (s.kind === 'git') {
    return 'Urfael update available: ' + (s.behind || 'new') + ' commit' + (String(s.behind) === '1' ? '' : 's')
      + ' on ' + (s.branch || 'main') + '. Say "update yourself", or run `urfael update`.';
  }
  return 'Urfael ' + (s.latest || 'a new version') + ' is available (you have v' + (s.current || '?') + '). Download: ' + RELEASES_URL;
}

// ---- I/O (all fail-soft) ------------------------------------------------------------------------------------
function git(root, args, cb) { execFile('git', ['-C', root, ...args], { timeout: 60000, maxBuffer: 1 << 20 }, cb); }

// gitState(root): {kind:'git', official, branch, behind, dirty, available} for a git checkout, or {kind:'app'}.
function gitState(root) {
  return new Promise((resolve) => {
    git(root, ['rev-parse', '--is-inside-work-tree'], (e) => {
      if (e) return resolve({ kind: 'app' });
      git(root, ['remote', 'get-url', 'origin'], (e2, origin) => {
        const official = !e2 && isOfficialRemote(String(origin || ''));
        git(root, ['fetch', '--quiet', 'origin'], () => {
          git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], (e3, br) => {
            const branch = String(br || '').trim() || 'main';
            git(root, ['rev-list', '--count', 'HEAD..origin/' + branch], (e4, cnt) => {
              const behind = parseInt(String(cnt || '0').trim(), 10) || 0;
              git(root, ['status', '--porcelain'], (e5, st) => {
                const dirty = !!String(st || '').trim();
                resolve({ kind: 'git', official, branch, behind, dirty, available: official && behind > 0 });
              });
            });
          });
        });
      });
    });
  });
}

// fetchLatestRelease(): the latest published release tag via the GitHub API (no `gh` dependency). '' on any failure.
function fetchLatestRelease() {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.get('https://api.github.com/repos/' + OFFICIAL + '/releases/latest',
      { headers: { 'User-Agent': 'urfael-updater', 'Accept': 'application/vnd.github+json' }, timeout: 8000 },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return fin(''); }
        let b = ''; res.on('data', (d) => { b += d; if (b.length > (1 << 20)) req.destroy(); }); res.on('end', () => fin(parseLatestTag(b)));
      });
    req.on('error', () => fin('')); req.on('timeout', () => { req.destroy(); fin(''); });
  });
}

// check(root, currentVersion): the unified status the daemon caches + surfaces.
async function check(root, currentVersion) {
  const g = await gitState(root);
  if (g.kind === 'git') return Object.assign({ current: currentVersion, t: nowIso() }, g);
  const tag = await fetchLatestRelease();
  const available = !!(tag && compareVersions(currentVersion, tag) < 0);
  return { kind: 'app', current: currentVersion, latest: tag || '', available, t: nowIso() };
}

// runGitUpdate(root): the ONLY mutate path. Fast-forwards the official origin + reinstalls deps. Fail-closed:
// refuses a non-git tree, a non-official origin, or a dirty tree. Returns {ok, branch?, error?}.
function runGitUpdate(root) {
  return new Promise((resolve) => {
    git(root, ['rev-parse', '--is-inside-work-tree'], (e) => {
      if (e) return resolve({ ok: false, error: 'this is an app install (no git checkout) — download the new build from ' + RELEASES_URL });
      git(root, ['remote', 'get-url', 'origin'], (e2, origin) => {
        if (e2 || !isOfficialRemote(String(origin || ''))) return resolve({ ok: false, error: 'refused: origin is not the official Urfael repo' });
        git(root, ['status', '--porcelain'], (e3, st) => {
          if (String(st || '').trim()) return resolve({ ok: false, error: 'refused: there are local changes — commit or stash them first' });
          git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], (e4, br) => {
            const branch = String(br || '').trim() || 'main';
            git(root, ['pull', '--ff-only', '--quiet', 'origin', branch], (e5) => {
              if (e5) return resolve({ ok: false, error: 'pull failed (a non-fast-forward?) — resolve it in ' + root });
              execFile('npm', ['install', '--silent'], { cwd: path.join(root, 'app'), timeout: 300000 }, (e6) => {
                resolve({ ok: true, branch, npmWarned: !!e6 });
              });
            });
          });
        });
      });
    });
  });
}

function nowIso() { try { return new Date().toISOString(); } catch { return ''; } }

module.exports = {
  OFFICIAL, RELEASES_URL,
  isOfficialRemote, compareVersions, parseLatestTag, summarize,    // pure
  gitState, fetchLatestRelease, check, runGitUpdate,               // I/O
};
