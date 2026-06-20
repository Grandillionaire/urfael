'use strict';
// app/plugin-import.js — the THIN, impure runner for the foreign-plugin importer (sibling of import.js). It walks a
// foreign plugin dir (symlink/.. safe via import.safeJoin, size-capped reads), hands the manifest TEXT to the PURE
// plugin-importcore (which never executes it), static-scans every bundled asset with the frozen skillhub.scan,
// previews the draft Urfael manifest via the unchanged pluginhub.preview, and — only under --apply — writes an
// INERT, 0600, DISABLED, UNSIGNED draft into quarantine. It NEVER signs, NEVER enables, NEVER auto-grants, NEVER
// runs foreign code. The owner then walks the unchanged native six-gate pipeline (scan → install → secret → enable).
const fs = require('fs');
const os = require('os');
const path = require('path');
const ic = require('./plugin-importcore');
const skillhub = require('./skillhub');
const pluginhub = require('./pluginhub');
const { safeJoin } = require('./import');

const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const MAX = 256 * 1024;
const QUARANTINE = path.join(os.homedir(), process.env.URFAEL_VAULT_DIR || 'Urfael', '_urfael', 'plugins-incoming');

function readIn(root, rel) { const p = safeJoin(root, rel); if (!p) return ''; try { const st = fs.statSync(p); if (!st.isFile() || st.size > MAX) return ''; return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function listDir(root) { try { return fs.readdirSync(root); } catch { return []; } }

// build the descriptor from a foreign plugin dir, honoring an explicit --from or auto-detecting.
function describe(root, from) {
  const files = listDir(root);
  const fmt = from || ic.detectFormat(files);
  if (fmt === 'openclaw') return { fmt, d: ic.parseOpenClaw(readIn(root, 'openclaw.plugin.json'), readIn(root, 'package.json'), readIn(root, 'openclaw.json')) };
  if (fmt === 'hermes' || fmt === 'hermes-plugin') return { fmt: 'hermes', d: ic.parseHermes(readIn(root, 'plugin.yaml') || readIn(root, 'plugin.yml'), readIn(root, 'config.yaml') || readIn(root, 'config.yml')) };
  return { fmt: 'unknown', d: null };
}

async function run(opts = {}) {
  const root = path.resolve(String(opts.path || '.'));
  if (!fs.existsSync(root)) { console.error('✗ no such path: ' + root); return { error: 'no path' }; }
  const { fmt, d } = describe(root, opts.from);
  if (!d) { console.error('✗ not a recognizable OpenClaw/Hermes plugin (no openclaw.plugin.json / plugin.yaml). Use --from to force.'); return { error: 'unknown format' }; }

  const { manifest, refusals, routedSkills } = ic.mapToManifest(d);

  // scan the bundled skills (frozen skillhub.scan; never executed)
  const skills = [];
  for (const rel of routedSkills) { const body = readIn(root, rel); if (!body) continue; const { flags } = skillhub.scan(body); const m = skillhub.meta(body, path.basename(rel).replace(/\.md$/i, '')); skills.push({ rel, slug: skillhub.slugify(m.name) || skillhub.slugify(rel), name: m.name, flags }); }

  // ── preview ──
  console.log(gold('── foreign plugin import') + dim('  (' + fmt + ': ' + (d.name || d.id || path.basename(root)) + ')'));
  if (manifest) {
    const parsed = pluginhub.parse(JSON.stringify(manifest));   // round-trip through the unchanged native loader → the canonical preview shape
    const p = parsed ? pluginhub.preview(parsed) : null;
    console.log(dim('   → a draft Urfael plugin manifest (UNSIGNED, will install DISABLED):'));
    console.log(dim('     tools  ') + ((p && p.tools.join(', ')) || dim('none')));
    console.log(dim('     net    ') + ((manifest.capabilities.net || []).map((n) => n.host).join(', ') || dim('none')));
    console.log(dim('     secret ') + ((manifest.capabilities.secret || []).map((s) => s.ref).join(', ') || dim('none')) + dim('  (by reference; you set values later)'));
    console.log(dim('     trust  ') + gold('signed NO  sha-pinned NO') + dim('  → re-enters the native six-gate pipeline'));
    if (p) console.log(dim('     sandbox ') + dim(p.cellArgs));
  } else {
    console.log(dim('   → no runnable external MCP server declared, so NO manifest is emitted (a tool name is not a server).'));
  }
  for (const s of skills) { const danger = s.flags.filter((f) => f.level === 'danger').length; console.log(dim('   skill  ') + gold(s.slug) + (s.flags.length ? gold('  ⚠ ' + s.flags.length + (danger ? ' (DANGER)' : '') + ' flag(s)') : dim('  scan clean'))); }
  if (refusals.length) { console.log(gold('   refused (in-process surfaces with no safe out-of-process form):')); for (const r of refusals) console.log('     ' + dim('· ' + r)); }
  if (!manifest && !skills.length) { console.log(gold('   nothing portable') + dim(' — this plugin is in-process code; refusing is the correct outcome.')); }

  if (!opts.apply) { console.log('\n' + dim('dry run — nothing written. Re-run with ') + gold('--apply') + dim(' to stage the draft + skills (0600, disabled).')); return { manifest, refusals, skills, applied: false }; }

  // ── --apply: write INERT artifacts only ──
  let wrote = 0;
  for (const s of skills) {
    if (s.flags.some((f) => f.level === 'danger')) { console.error('✗ skill ' + s.slug + ' tripped a DANGER flag — skipped (apply/force never override DANGER).'); continue; }
    if (!/^[a-z0-9-]+$/.test(s.slug)) continue;
    const dest = path.join(skillhub.SKILLS_DIR, s.slug + '.md');
    if (fs.existsSync(dest) && !opts.force) { console.error('✗ skill ' + s.slug + '.md exists — pass --force to overwrite.'); continue; }
    try { fs.mkdirSync(skillhub.SKILLS_DIR, { recursive: true }); fs.writeFileSync(dest, readIn(root, s.rel), { mode: 0o600 }); wrote++; console.log(gold('✓ staged skill ') + dest); } catch (e) { console.error('✗ ' + ((e && e.message) || e)); }
  }
  if (manifest) {
    const dir = path.join(QUARANTINE, manifest.id);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 }); wrote++; console.log(gold('✓ staged draft manifest ') + path.join(dir, 'plugin.json') + dim('  (DISABLED, unsigned)')); } catch (e) { console.error('✗ ' + ((e && e.message) || e)); }
    console.log('\n' + dim('next (the unchanged native gates — your call at each step):'));
    console.log('  ' + gold('urfael plugin scan ' + path.join(dir, 'plugin.json')));
    console.log('  ' + gold('urfael plugin install ' + path.join(dir, 'plugin.json')) + dim('   then  ') + gold('urfael plugin enable ' + manifest.id));
  }
  return { manifest, refusals, skills, applied: true, wrote };
}

module.exports = { run, describe, readIn, QUARANTINE };
