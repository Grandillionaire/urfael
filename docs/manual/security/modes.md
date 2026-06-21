# Fortress vs Full

Urfael ships two modes and you pick one per your risk tolerance. The default is the locked-down one.

```bash
urfael status   # shows the current mode
urfael setup    # choose Fortress or Full (writes URFAEL_MODE)
```

## Fortress (default)

Fortress keeps remote turns (chat) read-only with no egress. For owner and member senders, a remote turn can read and search the vault only (`Read`, `Grep`, `Glob`). It cannot reach the network at all. So "read a secret and POST it somewhere" has nowhere to send it. Guests get `Read` only.

## Full (opt-in)

Full widens owner and member remote turns to web reach: those turns gain `WebFetch` and `WebSearch` on top of the read tools. Guests are unchanged (`Read` only).

Full keeps every other guard that Fortress has:

- No unsandboxed shell (`Bash`) on a remote turn, ever.
- No `bypassPermissions` on a remote turn, ever.
- The untrusted-data framing stays on.
- The credential-store `permissions.deny` (Read and Write on `~/.claude`, `~/.ssh`, dotfiles, LaunchAgents) stays enforced.
- No Write or Edit on a remote turn. A remote write is not confined to the vault directory, so it could escape, and it is excluded by design in both modes. A vault-confined remote-write capability is a planned, separately-verified follow-up, not something Full grants today.

## The honest tradeoff

Full is opt-in for one reason: egress. A remote turn in Full mode can reach the network, so a prompt-injection hidden in something the agent reads (an email it summarizes, a page it fetches) could in principle read your vault notes and send them out over the web. The untrusted-data envelope reduces this risk. It does not structurally prevent it the way Fortress's no-egress profile does. Your credentials stay safe either way (the deny covers them), but in Full your notes become reachable and exfiltratable.

Use Full when you want web reach. Use Fortress when the data on the machine is sensitive and you want the no-egress guarantee.

## Switching

Run `urfael setup` and pick a mode, or set the env var directly: `URFAEL_MODE=full` for Full, unset (or anything else) for Fortress. Either way, restart the daemon for the change to take effect.

`URFAEL_MODE` is the owner's setting (it lives in the daemon's environment). A remote sender can never choose it, so no chat message can put itself into Full mode.

## Guaranteed in both modes

These hold structurally and are asserted by `npm run security`:

- No inbound network port (the brain is a unix socket).
- A remote turn is never the full-power `local` profile. No role and no mode reaches it; `local` needs an absent channel (the on-machine mic).
- No `bypassPermissions` and no `Bash` on a remote turn.
- The credential-store deny holds.

## Further reading

The full engineering writeup, including the per-tool comparison table and the reasoning behind excluding remote writes, lives in [docs/MODES.md](https://github.com/Grandillionaire/urfael/blob/main/docs/MODES.md) on GitHub. See also [start/quickstart.md](start/quickstart.md) to get the daemon running.
