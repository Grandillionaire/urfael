# Setup, channel by channel

This page is the practical wiring. Where the tokens go, how you put yourself (and teammates) on the allowlist, and how a one-off pairing code works. For the why behind the allowlist and the read-only sandbox, read [channels/overview.md](channels/overview.md) first.

Everything lives in one file: `~/.claude/urfael/bridge.env`. Copy it from `config/bridge.env.example`, fill in only the channels you want, and `chmod 600` it. With the file absent, every bridge and phone notification is off. The example file has per-channel instructions for each token and id; this page summarizes the keys and the roster commands.

## Two ways to be on the allowlist

A channel answers a sender only if that sender resolves to a known principal. There are two sources of truth, and they stack:

1. The single-owner env key. Set `TELEGRAM_OWNER_CHAT_ID` (and so on per channel) and that one id is the lone owner. This is enough for a personal, one-user setup, and it is what existing installs use.
2. The team roster in `~/.claude/urfael/team.json`. The moment you add anyone with `urfael team add`, that file becomes the per-channel allowlist. The env owner still counts; the roster adds more people with explicit roles.

`buildRoster` in `app/lib.js` merges the two. You do not edit `team.json` by hand; the CLI writes it `0600` and atomically.

## Adding people: `urfael team add`

```bash
urfael team add <channel> <id> [name] [role]
```

- `channel` must be one of: `telegram`, `discord`, `slack`, `imessage`, `email`, `matrix`, `signal`, `whatsapp`, `qq`, `simplex`, `phone`. An unknown channel is rejected with the valid list.
- `id` is the same stable identifier the channel allowlists on (see the table below). It is required.
- `name` is a label for the audit trail. Defaults to the id.
- `role` is `owner`, `member`, or `guest`. Anything else (or omitted) becomes `guest`. The role only ever narrows access; it cannot escalate a remote turn to full power.

Changes take effect live. The Telegram bridge, for example, reloads the roster on the next batch of updates, so you do not restart anything.

```bash
urfael team add telegram 123456789 "Sam" member   # add a teammate as a member
urfael team                                        # show the roster
urfael team remove telegram 123456789              # take them off
```

## A worked example: Telegram

```bash
# in ~/.claude/urfael/bridge.env
TELEGRAM_BOT_TOKEN=123456:ABC-your-botfather-token
TELEGRAM_OWNER_CHAT_ID=987654321
```

Message `@BotFather` with `/newbot` for the token. Get your numeric chat id from `@userinfobot`, or DM your bot and read `message.chat.id` from `https://api.telegram.org/bot<token>/getUpdates`. Run the bridge (`node app/bridge/telegram-bridge.js`, or let the daemon supervise it). It long-polls outbound only and opens no inbound port. Your messages get a `...thinking` placeholder that is edited in place with the reply. Voice memos up to five minutes are transcribed locally with whisper.cpp and echoed back as `heard: ...` first.

## A worked example: Email

Email is inbound IMAP IDLE and draft-only outbound. It never sends a message. Each allowlisted, unread mail is relayed to the sandboxed brain and the reply is appended to your Drafts as a `Re: ...` for you to send yourself.

```bash
# in ~/.claude/urfael/bridge.env
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_USER=you@example.com
EMAIL_PASS=your-app-specific-password
EMAIL_ALLOWED_SENDERS=you@example.com,trusted@example.com
EMAIL_DRAFT_MAILBOX=Drafts
EMAIL_POLL_SECS=60
```

`EMAIL_PASS` must be an app-specific password, never your real one. The allowlist is `EMAIL_ALLOWED_SENDERS`, a comma-separated list of From addresses; leave it blank and the bridge refuses to start. The From check rides only on the isolated header block, so a body line that reads `From: owner@allowed.com` cannot forge a sender.

Two extras. A sender in `EMAIL_ALLOWED_SENDERS` who is not on `team.json` defaults to `member`, so for finer roles add them with `urfael team add email <address> "Name" guest`. And `EMAIL_TRIGGERS`, a JSON array, fires a one-way push to you when a matching mail arrives, separate from the draft:

```json
[{"from":"boss@","action":"notify"},{"subject":"invoice","action":"ask"}]
```

`notify` pushes the sender and subject; `ask` also pushes the brain's short take. A rule with no `from` and no `subject` never matches, by design.

## The rest, at a glance

The owner identifier is the value for the single-owner env key and also the `id` you pass to `urfael team add`.

| Channel | Owner id env key | What the id is | Transport keys |
|---|---|---|---|
| `telegram` | `TELEGRAM_OWNER_CHAT_ID` | numeric chat id | `TELEGRAM_BOT_TOKEN` |
| `discord` | `DISCORD_OWNER_USER_ID` | numeric user id | `DISCORD_BOT_TOKEN` |
| `slack` | `SLACK_OWNER_USER_ID` | `U...` member id | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` |
| `imessage` | `IMESSAGE_OWNER_HANDLE` | `+E.164` phone or Apple ID email | (macOS, Full Disk Access; `IMESSAGE_POLL_SECS`) |
| `email` | (allowlist, see above) | From address | `EMAIL_IMAP_HOST`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_ALLOWED_SENDERS` |
| `matrix` | `MATRIX_OWNER_USER_ID` | `@you:server` | `MATRIX_HOMESERVER`, `MATRIX_TOKEN`, optional `MATRIX_ROOM_ID` |
| `signal` | `SIGNAL_OWNER_NUMBER` (or `SIGNAL_OWNER_UUID`) | `+E.164` number, or account UUID | `SIGNAL_ACCOUNT`, `SIGNAL_CLI_PATH` |
| `whatsapp` | `WHATSAPP_OWNER_NUMBER` | international digits | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_WEBHOOK_PORT` |
| `qq` | `QQ_OWNER_OPENID` | bot openid | `QQ_APP_ID`, `QQ_APP_SECRET` |
| `simplex` | `SIMPLEX_OWNER_CONTACT_ID` | local integer contact id | `SIMPLEX_WS_URL` |
| `phone` | `PHONE_OWNER_NUMBER` | `+E.164` number | `TWILIO_AUTH_TOKEN`, `VOICE_PUBLIC_URL` |

The owner-key-to-channel mapping is `OWNER_ENV` in `app/bridge/bridge-core.js`. WhatsApp digits are normalized to match Meta's E.164, and Signal accepts either the number or the UUID.

## How battle-tested each one is

Be honest with yourself about maturity. The README says it and so does this page:

- Solid and best-tested: Telegram, Discord, Slack, iMessage, Email. The README counts these (plus Matrix) as the curated eight.
- Code-complete and reviewed, but not yet exercised against real accounts: the live relay of Matrix, Signal, and WhatsApp. Their parsing and allowlist logic is unit-tested; the network path is not battle-hardened. Treat them accordingly.
- Newer still: `qq`, `simplex`, and `phone` are real channel names the roster validates, with less mileage again. WhatsApp and phone are also the only inbound surfaces, so they carry more surface area; see the overview.

## Native webhook channels

Eight more channels run on one loopback-only receiver, `app/bridge/webhook-bridge.js`, started like the hooks receiver. It binds `127.0.0.1` only and opens no port on the daemon, so to accept events from a platform you point your own tunnel (cloudflared, ngrok) at it and give the platform the URL `https://your-tunnel/wh/<channel>`.

```bash
node app/bridge/webhook-bridge.js     # loopback only; tunnel to it for external events
```

Each channel has a tiny pure adapter in `app/bridge/webhook-lib.js` that verifies the platform's real signature (timing-safe) and extracts the sender and text. Authorization is not the adapter's job: the bridge runs the same fail-closed allowlist as every other channel before the brain. Set the channel's secret in `bridge.env` and add yourself with `urfael team add <channel> <your-id>`:

| Channel | Secret in `bridge.env` | Verification | Owner id env |
|---|---|---|---|
| `mattermost` | `MATTERMOST_TOKEN` | outgoing-webhook token | `MATTERMOST_OWNER_USER_ID` |
| `googlechat` | `GOOGLECHAT_TOKEN` | shared token (JWT-cert mode is the cert step) | `GOOGLECHAT_OWNER_NAME` |
| `sms` | `TWILIO_AUTH_TOKEN` | Twilio HMAC-SHA1 request signature | `SMS_OWNER_NUMBER` |
| `dingtalk` | `DINGTALK_SECRET` | HMAC-SHA256 sign + timestamp freshness | `DINGTALK_OWNER_STAFF_ID` |
| `homeassistant` | `HOMEASSISTANT_TOKEN` | bearer/shared token | `HOMEASSISTANT_OWNER` |
| `bluebubbles` | `BLUEBUBBLES_PASSWORD` | shared password | `BLUEBUBBLES_OWNER_HANDLE` |
| `feishu` | `FEISHU_VERIFY_TOKEN` | verification token (encrypt mode is the cert step) | `FEISHU_OWNER_OPEN_ID` |
| `wecom` | `WECOM_TOKEN` | sorted-SHA1 message signature | `WECOM_OWNER_USER` |

Mattermost, Google Chat, SMS, DingTalk, and Home Assistant answer in the HTTP response. BlueBubbles, Feishu, and WeCom send their reply back through the platform's own API, which is the live-certification step. Behind a tunnel, set `URFAEL_WEBHOOK_PUBLIC_URL` so the Twilio signature check sees the same URL the platform signed. These adapters are unit-tested and the allowlist is frozen as a benchmark check; each platform's live round-trip is the remaining certification.

## Pairing: a single-use guest code

When you cannot share a token or chat id ahead of time, mint a code instead:

```bash
urfael team pair [channel] [--ttl <mins>]
```

This asks the daemon to mint a single-use, time-bounded code, shown once. The new person DMs exactly that code to your bot. The bridge sees a sender who is not on the roster, forwards the code to the daemon's `/pair/redeem`, and on success enrolls them.

The one thing that matters for security: pairing always enrolls a `guest`, and nothing else. The role is hard-coded in `newPairCode`/`redeemPairCode` in `app/lib.js`, with no parameter to request `owner` or `member`. Only the SHA-256 hash of the code is stored, redemption is constant-time, and an expired or channel-mismatched code is skipped. So a pairing code can never mint a privileged principal, even by accident. A guest is the most restricted role: read a known path only, no browsing or searching your vault. To grant more, add them explicitly with `urfael team add`.

## Going deeper

The full per-token instructions, including the privileged Discord intent, the Slack scopes, Gmail app passwords, and the WhatsApp tunnel, are in `config/bridge.env.example` and in [docs/SETUP.md](https://github.com/Grandillionaire/urfael/blob/main/docs/SETUP.md). The roles, the audit trail, and the multi-user reasoning are in [docs/TEAM-MODE.md](https://github.com/Grandillionaire/urfael/blob/main/docs/TEAM-MODE.md). To see who reached the brain and under which profile, run `urfael audit`.
