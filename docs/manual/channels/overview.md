# Channels

A channel is a way for a person to reach Urfael from somewhere other than the machine it runs on. Urfael knows eleven of them:

`telegram`, `discord`, `slack`, `imessage`, `email`, `matrix`, `signal`, `whatsapp`, `qq`, `simplex`, `phone`.

(The README counts eight as the curated, documented set. The roster code in `app/lib.js` validates all eleven, so all eleven are real channel names you can put a principal on. The newer ones have had less real-world mileage; see [What is lightly tested](#what-is-lightly-tested) below.)

## The one rule

Every inbound message is allowlisted to a known principal before the brain sees it. This is not a filter the model applies. It happens in the bridge, before a single token reaches Claude.

When a message arrives on a channel, the bridge resolves the sender against your roster:

```
incoming (channel, senderId)
   -> resolvePrincipal(roster, channel, senderId)
   -> a known principal, or null
```

`resolvePrincipal` (in `app/lib.js`) is fail-closed. A sender who is not on the roster for that channel returns `null`, and the bridge drops the message and writes an audit line. There is no default-allow. An unknown role on a listed principal is treated as the most restricted role (`guest`), never widened.

The allowlist key is always the stable, hard-to-spoof identifier, never a display name. For Telegram it is your chat id, for Discord your user id, for Signal your account UUID, for SimpleX the local integer contact id, and so on. The full mapping lives in `OWNER_ENV` in `app/bridge/bridge-core.js`.

If you have not set up a team roster, the single-owner environment variable for that channel (for example `TELEGRAM_OWNER_CHAT_ID`) is the lone allowed principal. So existing single-owner setups behave the same way: one person, allowlisted, everyone else dropped.

## Remote turns run read-only

Passing the allowlist gets you in. It does not give you the run of the machine.

The daemon tags each `/ask` with its `channel`. A turn with no channel is the local mic or overlay on the machine itself, and it runs as `local` with full power. Every remote channel is mapped to a sandboxed profile instead. By default that profile is `untrusted`:

- Allowed tools: `Read`, `Grep`, `Glob` only.
- No `Write`, no `Edit`, no `Bash`.
- No `WebFetch` or `WebSearch`, so there is no network egress.
- The message text is wrapped in a nonce-framed untrusted-data envelope, as a prompt-injection mitigation.

The reasoning is in `app/lib.js`: a network tool would turn "read a local secret" into a way to send that secret to any URL, and `Bash` or a write could touch dotfiles or launch agents. With those off, the worst case under prompt injection is Urfael echoing a local file back to your own chat. No third party.

Profile resolution is fail-closed too. An unknown or missing profile name resolves to `untrusted`, never to `local`. A guest principal is narrower still: `Read` only, with no `Grep` or `Glob`, so a guest cannot browse or search your vault.

You can widen this deliberately. Fortress (the default) keeps remote turns read-only with no egress. Full mode (`URFAEL_MODE=full`) lets remote owner and member turns reach the web (`WebFetch`, `WebSearch`), while still keeping no shell, no bypass, the framing, and the credential deny. A remote sender can never select the mode; it is the daemon's own setting, not part of the message. See [security/modes.md](security/modes.md).

## No inbound port

The topology is one-way. Urfael reaches out; nothing reaches in.

The brain speaks only over a `0600` unix socket. It opens no TCP port. The bridges connect outward to each chat platform's API and poll for messages, or they are fronted by a tunnel you run yourself:

- Telegram polls with long-poll `getUpdates` (outbound HTTPS only).
- Discord, Slack, Matrix, and QQ connect outward to their APIs.
- iMessage (macOS) reads the local `chat.db` and replies via AppleScript.
- Signal wraps the local `signal-cli` binary and parses its JSON output.
- SimpleX dials a co-located `simplex-chat` CLI on loopback.
- Email uses IMAP IDLE inbound and is draft-only outbound: it writes replies to your Drafts and never sends.
- WhatsApp is the one genuinely inbound surface. Meta's Cloud API webhook binds `127.0.0.1` only and is HMAC-verified, and you point your own tunnel (cloudflared, ngrok, a reverse proxy) at it. It does not open a port on your behalf.

So even WhatsApp does not expose a listener to the LAN or the internet by default. You decide what, if anything, gets a tunnel.

## What is lightly tested

The pure parsing and allowlist logic for every channel is unit-tested. The live relay of the Matrix, Signal, and WhatsApp bridges has not been exercised against real accounts yet; treat those as code-complete and reviewed, not battle-hardened. Linux paths are newer than macOS. The README states this plainly and so do we.

## Where to go next

- To wire up a specific channel, including the exact tokens and ids each one needs, see [channels/setup.md](channels/setup.md).
- For the full sandbox profiles, fail-closed resolution, and the threat reasoning behind read-only remote turns, see [security/model.md](security/model.md).
- For Fortress versus Full and how to widen remote reach safely, see [security/modes.md](security/modes.md).
- For multiple allowlisted people per channel and the role rules, see [security/team.md](security/team.md).

The allowlist and the sandbox profiles are defined in [app/lib.js](https://github.com/Grandillionaire/urfael/blob/main/app/lib.js), and the per-channel transport plumbing in [app/bridge/bridge-core.js](https://github.com/Grandillionaire/urfael/blob/main/app/bridge/bridge-core.js).
