# Drive it from your editor (ACP)

`urfael acp` lets an editor drive Urfael as its backend brain over the Agent Client Protocol, the JSON-RPC surface that Zed, JetBrains, Neovim, and the VS Code ACP extension already speak. The editor spawns `urfael acp` as a foreground subprocess and talks to it over the stdin and stdout it hands the process. There is no second protocol to learn and nothing new to run.

## It opens no port

This is the design constraint. `urfael acp` speaks JSON-RPC on the editor's stdio, and its only network primitive is the outbound connection to the existing `0600` daemon socket. It never calls `.listen()`. No new TCP port, no loopback bind, nothing to expose. It is quieter than `urfael serve`, `urfael dashboard`, and `urfael hooks`, each of which at least binds a loopback port. A frozen benchmark check asserts the bridge has zero listeners. See the [security model](security/model.md) for why the no-port property matters.

## Wiring an editor

In Zed's settings:

```json
{ "agent_servers": { "urfael": { "command": "urfael", "args": ["acp"] } } }
```

Then open the agent panel and pick Urfael.

Run the probe first to confirm the daemon is reachable. It prints the same config snippet:

```bash
urfael acp --probe
```

## Spawning it grants owner authority

Read this before you enable it. A message that arrives with no channel attached runs Urfael's full-power local owner turn (files, shell, web, your owner connectors), and the ACP bridge sends prompts on exactly that path. So spawning `urfael acp` grants the editor owner-equivalent authority.

This is acceptable for single-user use, because the editor already runs as your uid and could open the `0600` socket directly anyway. The filesystem permission is the credential, the same way the API token is for `urfael serve`. It is not a multi-tenant or remote-collaboration surface. Treat enabling it as sensitive.

## What works, and what it does not

Verified by unit and benchmark tests today:

- Streamed assistant text, with the spoken-aside markers stripped incrementally so a voice aside cannot leak into your editor buffer.
- A tool row per tool the brain uses.
- Model and persona switching through the editor's session-mode control.
- Cancel, which aborts the in-flight turn.

Deliberate limits, stated plainly:

- **Tool calls are name-only.** The daemon stream exposes the tool name, not its arguments or result, so the editor shows a tool row but no native in-editor diffs.
- **Editor-supplied MCP servers are dropped on purpose.** ACP lets an editor hand the agent its own MCP servers per session. Urfael does not forward them into the trusted local turn, because that would breach the owner-turns-only connector boundary. See [connectors](features/connectors.md).
- **One warm conversation.** The daemon has a single serialized owner brain, so v1 refuses a second concurrent prompt rather than corrupt the stream.
- **No per-tool permission popups.** Authority stays in the daemon roster and profile system, not the editor's allow/reject UI.
- **stdio only.** The remote ACP transport (HTTP/WebSocket) is out of scope here, because adopting it would reintroduce a port.

## Status

The protocol translation and the no-port guarantee are unit-tested and benchmark-frozen. The one remaining step is a live round-trip in a real ACP editor (Zed), which is the human acceptance gate, separate from the green automated suite.

The full engineering writeup lives at [docs/ACP.md](https://github.com/Grandillionaire/urfael/blob/main/docs/ACP.md).
