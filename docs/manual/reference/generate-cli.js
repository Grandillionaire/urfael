'use strict';
// Generates docs/manual/reference/cli.md from app/registry.js — the single source of truth for the CLI surface.
// Run from anywhere: `node docs/manual/reference/generate-cli.js`. Committed output + generator, so the reference
// can be regenerated in CI and can never drift from the real command graph. No deps.
const fs = require('fs');
const path = require('path');
const reg = require(path.join(__dirname, '..', '..', '..', 'app', 'registry.js'));

// The doc avoids em/en dashes (an AI-writing tell) even though the CLI's own help text keeps them. clean() rewrites
// any dash separator in a summary to a comma when emitting markdown; the binary's strings are untouched.
const clean = (s) => String(s).replace(/\s*[–—]\s*/g, ', ');
const groupDesc = (key) => clean(String(reg.GROUPS[key] || key).replace(new RegExp('^' + key + '\\s*'), '').trim());
const title = (key) => key.charAt(0) + key.slice(1).toLowerCase();
const esc = (s) => String(s).replace(/\|/g, '\\|');

const out = [];
out.push('<!-- AUTO-GENERATED from app/registry.js by docs/manual/reference/generate-cli.js. Do not edit by hand. -->');
out.push('');
out.push('# CLI reference');
out.push('');
out.push('Every command Urfael ships, generated straight from the source of truth so it always matches the binary. Run `urfael help` for the same list in your terminal, or `urfael help <command>` to drill into one.');
out.push('');
out.push('Aliases are accepted everywhere the canonical name is. Hidden subcommands (folded under a parent here) work the same on the command line.');
out.push('');

const seen = new Set();
for (const key of Object.keys(reg.GROUPS)) {
  const cmds = reg.COMMANDS.filter((c) => c.group === key && !c.hidden);
  if (!cmds.length) continue;
  out.push('## ' + title(key));
  const d = groupDesc(key);
  if (d) out.push('', '_' + d + '_');
  out.push('');
  for (const c of cmds) {
    seen.add(c.name);
    out.push('### `urfael ' + c.name + '`');
    out.push('');
    out.push(clean(c.summary) + '.');
    out.push('');
    out.push('```bash');
    for (const line of String(c.usage).split('\n')) out.push(line);
    out.push('```');
    if (c.aliases && c.aliases.length) out.push('', 'Aliases: ' + c.aliases.map((a) => '`' + a + '`').join(', '));
    if (c.examples && c.examples.length) {
      out.push('', 'Examples:', '', '```bash');
      for (const e of c.examples) out.push(e);
      out.push('```');
    }
    if (c.see && c.see.length) out.push('', 'See also: ' + c.see.map((s) => '`' + s + '`').join(' · '));
    out.push('');
  }
}

// hidden subcommands, listed compactly so the reference is complete
const hidden = reg.COMMANDS.filter((c) => c.hidden);
if (hidden.length) {
  out.push('## Hidden subcommands');
  out.push('');
  out.push('Folded under a parent command above, but valid on their own:');
  out.push('');
  out.push('| Command | What it does |');
  out.push('|---|---|');
  for (const c of hidden) out.push('| `urfael ' + c.name + '` | ' + esc(clean(c.summary)) + ' |');
  out.push('');
}

out.push('---');
out.push('');
out.push('Generated from `app/registry.js`. To regenerate: `node docs/manual/reference/generate-cli.js`.');
out.push('');

fs.writeFileSync(path.join(__dirname, 'cli.md'), out.join('\n'));
process.stdout.write('wrote reference/cli.md (' + reg.COMMANDS.length + ' commands across ' + Object.keys(reg.GROUPS).length + ' groups)\n');
