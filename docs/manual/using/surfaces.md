# The surfaces

One brain, several ways to reach it. Every surface is a thin client of the same local daemon, talking to it over the `0600` unix socket. So a conversation you start by voice in the Console shows up in the TUI, the dashboard, and a chat channel alike. There is no separate state per surface.

Pick the one that fits the moment. Nothing here opens a network port on its own; the web surfaces bind to loopback only and are token gated.

## The Console

The desktop app, and the one most people live in. It opens with `cd app && npm start`.

You get streamed replies with one line of tool activity per call, push to talk, the full conversation archive, reminders, background jobs, a live cost panel (Hearth), and settings. It is keyboard first, with a `⌘K` command palette for fuzzy view switching and `⌘1-6` to jump between views. `⌘⇧O` opens the window, `⌘⇧Q` quits. The spoken reply streams sentence by sentence while the full written answer lands on screen. See [features/voice.md](features/voice.md).

## The orb HUD

An ambient, click through marker in the corner of your screen. It is off by default; turn it on with `URFAEL_ORB=1`. It has four looks (`sigil`, `rune`, `ember`, `eye`), cycled with `⌘⇧T`, and `⌘⇧U` shows or hides it. Speak the wake word and talk hands free. The orb is presence, not a place to read long answers; for that, open the Console.

## The terminal cockpit (`urfael tui`)

A full screen terminal cockpit with no dependencies: raw stdin, ANSI, readline. Run it with:

```bash
urfael tui
```

It shows a streamed transcript with live tool activity, a status bar with the model and today's turn count, and scrollback. `Enter` sends, `Esc` aborts the in flight turn, `q` on an empty line quits, `^L` clears, and `Up` recalls your last message. It always restores your terminal on exit, on every exit path, including a crash.

`^T` cycles the theme (gold, ember, mono, custom) and `^Y` cycles the thinking animation.

### The `/` command palette

Type `/` and a palette floats above the prompt and filters as you type, the way Claude Code does it. A `/command` is never sent to the brain, so `/clear` clears the screen instead of asking the model about it. Each command opens the right tool for the job:

- `/persona` and `/model` open a navigable card picker: arrow through, type to filter, `Enter` to switch.
- `/theme` previews live as you move the selection, and `Esc` reverts.
- `/anim` sets the worker animation you see the next time it thinks.
- `/search` runs full text recall over every past conversation (it queries the same `/recall` index the brain uses). More in [features/memory.md](features/memory.md).
- `/usage` shows today, last 7 days, and last 30 days. Token counts are exact; the dollar figure is an estimate, never asserted as fact. See [features/overview.md](features/overview.md).
- `/stop` aborts a running turn, `/help` lists the whole palette, `/clear` and `/quit` do what they say.

The full source is at [app/tui.js](https://github.com/Grandillionaire/urfael/blob/main/app/tui.js).

## The web dashboard (`urfael dashboard`)

A token gated localhost web page:

```bash
urfael dashboard
```

It prints a URL bound to `127.0.0.1` only, with a constant time token check and no arbitrary path serving, so it is unreachable from your LAN or the internet. It is a responsive web app you can add to your home screen (a web manifest, not a full offline PWA: there is no service worker), so over a tunnel you arrange yourself, it works from your phone too. The browser surface the others have, locked down harder.

A separate command, `urfael serve [--token]`, exposes an OpenAI compatible API at `http://127.0.0.1:7720/v1`, also loopback only and token gated, so tools like Open WebUI or the `openai` SDK can use Urfael as their backend. See [features/models.md](features/models.md).
