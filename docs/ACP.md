# Driving Urfael from an editor (ACP)

`urfael acp` lets an editor or another agent drive Urfael as its backend brain, over the **Agent Client Protocol** (the JSON-RPC surface that Zed, JetBrains, Neovim, and the VS Code ACP extension already speak). The point: close the "be drivable from an editor" gap that OpenClaw and Hermes have, without giving up the one thing that makes Urfael safe.

## It opens no port

This is the whole design constraint. `urfael acp` is a foreground subprocess the editor spawns. It speaks JSON-RPC on the stdin and stdout the editor hands it, and its only network primitive is the outbound connection to the existing `0600` daemon socket. It never calls `.listen()`. There is no new TCP port, no loopback bind, nothing to expose. It is strictly quieter than `urfael serve`, `urfael dashboard`, and `urfael hooks`, each of which at least binds a loopback port. A frozen benchmark check asserts the bridge has zero listeners.

## Wiring an editor

In Zed's settings:

```json
{ "agent_servers": { "urfael": { "command": "urfael", "args": ["acp"] } } }
```

Then open the agent panel and pick Urfael. Run `urfael acp --probe` first to confirm the daemon is reachable and print this snippet.

## The honest auth reality (read this)

A message that arrives with no channel attached runs Urfael's full-power local owner turn (files, shell, web, your owner connectors). The ACP bridge sends prompts on exactly that path. So **spawning `urfael acp` grants the editor owner-equivalent authority.** This is acceptable for single-user use, because the editor already runs as your uid and could open the `0600` socket directly anyway: the filesystem permission is the credential, exactly as the API token is for `urfael serve`. It is **not** a multi-tenant or remote-collaboration surface. Treat enabling it as sensitive.

## What it does, and what it deliberately does not

Works today (unit and benchmark verified):
- Streamed assistant text, with the spoken-aside markers stripped incrementally so a voice aside can never leak into your editor buffer.
- A tool row per tool the brain uses.
- Model and persona switching through the editor's session-mode control.
- Cancel, which aborts the in-flight turn.

Deliberate limits, stated plainly so expectations are calibrated:
- **Tool calls are name-only.** The daemon stream exposes the tool name, not its arguments or result, so the editor shows a tool row but not native in-editor diffs. Closing that needs new daemon stream surface and is out of scope for the thin bridge.
- **Editor-supplied MCP servers are dropped on purpose.** ACP lets an editor hand the agent its own MCP servers per session. Urfael does not forward them into the trusted local turn, because that would breach the owner-turns-only connector boundary. This is a chosen divergence in favor of the moat.
- **One warm conversation.** The daemon has a single serialized owner brain, so two editors or two sessions interleave onto the same conversation; v1 refuses a second concurrent prompt rather than corrupt the stream.
- **No per-tool permission popups.** Authority stays in the daemon roster and profile system, not the editor's allow/reject UI.
- **stdio only.** The remote ACP transport (HTTP/WebSocket) is out of scope forever here, because adopting it would reintroduce a port.

## Status

The protocol translation and the no-port guarantee are unit-tested and benchmark-frozen. The one remaining step is a live round-trip in a real ACP editor (Zed), which is the human acceptance gate, separate from the green automated suite.
