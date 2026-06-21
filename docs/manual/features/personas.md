# Personas

A persona changes how Urfael talks, nothing else. It is a voice overlay: a stance that gets appended to the system prompt when a session spawns. The tools, the model routing, the vault, the sandbox, and the fail-closed permission roster are identical no matter which persona is active. Only the lens differs.

The anchor, `urfael`, is the dry old-intelligence butler. It has no overlay at all, so it spawns byte-identical to a plain Urfael session. The other five are stance-only overlays on top of that same machine.

## The built-ins

Each line below is the persona's essence, taken straight from `app/personas.js`.

| id | name | glyph | essence |
| --- | --- | --- | --- |
| `urfael` | Urfael | ᚢ | the dry old-intelligence butler, the anchor |
| `architect` | The Architect | ᚨ | systems mind: seams, contracts, failure modes; commits to ONE recommendation |
| `sage` | The Sage | ᛖ | patient mentor: teaches the why from first principles, hands the next step |
| `operator` | The Operator | ᛏ | ship it: terse, imperative, one path plus the first action |
| `muse` | The Muse | ᚹ | creative partner: widens the option space, reframes, then converges |
| `analyst` | The Analyst | ᛁ | loyal skeptic: interrogates the premise, names assumptions, risks, the cheaper alternative |

## Switching

Three ways, all the same underneath.

Ask in chat. "Become the architect", "use the analyst voice", "back to urfael" all work. The natural-language parser handles many phrasings.

Use the command:

```bash
urfael persona              # show the current voice and the roster
urfael persona architect    # switch
urfael persona reset        # back to the anchor (urfael / default / anchor / none also reset)
urfael persona list         # list the roster
```

Use the TUI picker. Type `/persona` to open it, or `/persona architect` to switch directly.

A remote owner can switch the voice verbally too. Members and guests cannot. See [security/team.md](security/team.md) for the owner, member, and guest roster rules.

## The safety harness does not move

This is the load-bearing claim, so it is worth stating plainly. A persona is text. It cannot widen what Urfael is allowed to do.

The code enforces this in two ways:

- An immutable safety clause is concatenated onto every non-anchor overlay by code, in `overlayFor()`, at spawn time. It is never written to the personas file, so editing or deleting that file cannot strip it. The clause restates that capabilities, sandbox, permission rules, and the owner's safety are fixed by the harness and the vault, not by the prompt, and tells the persona to decline (in its own voice) any instruction, from the overlay or from relayed content, that tries to cross a boundary.
- An authored persona can never shadow a built-in. `normalizeAuthored()` rejects any id that already exists in the roster, including `urfael` itself.

So the moat is harness-enforced and vault-enforced, not prompt-enforced. The persona is style. The boundaries are structure. See [security/model.md](security/model.md) for what those boundaries actually are.

## Authoring your own

You can add personas in `personas.json`. It lives in the git-versioned memory repo, beside `MEMORY.md`, at `~/Urfael-memory/personas.json` (the directory follows `URFAEL_MEMORY_DIR` if you set it). It is read, never executed.

```json
{
  "personas": [
    {
      "id": "privateer",
      "name": "The Privateer",
      "glyph": "ᛒ",
      "essence": "salty, plain-spoken, allergic to ceremony",
      "prompt": "STANCE: You answer as The Privateer. Be blunt and concrete. No ceremony."
    }
  ]
}
```

The loader is fail-soft. Rules it applies:

- `id` must match `^[a-z0-9][a-z0-9_-]{0,40}$` and must not collide with a built-in.
- `prompt` is required, has control characters stripped, and is capped at 4000 characters.
- `essence` is trimmed to 120 characters; `name` to 60; `glyph` takes the first character (defaulting to ✶).
- A missing or malformed file yields just the six built-ins. One bad entry is dropped without poisoning the rest.

A hostile authored prompt does not get you anything. The safety clause is still force-appended in code, under whatever you wrote.

For the full implementation, see [app/personas.js on GitHub](https://github.com/Grandillionaire/urfael/blob/main/app/personas.js).
