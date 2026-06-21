# Connectors (MCP)

Channels are how people reach Urfael. Connectors are how Urfael reaches your tools: GitHub, Notion, Slack, Postgres, Stripe, your calendar, a vector store, more. A connector is just an MCP server, the open standard the `claude` brain already speaks. The brain wires one up with `claude mcp add`, so you are not limited to a hand-built list. Any server from the public registries works. `urfael connect` curates the popular ones and makes setup one command, done the same paranoid way Urfael treats skills.

Connectors are not plugins. A connector is an MCP server (this page). A plugin is sandboxed and signed code that runs inside Urfael. See [features/plugins.md](features/plugins.md) for that. The skill model is in [features/skills.md](features/skills.md).

## The commands

```bash
urfael connect add github      # preview, scan, masked secret prompt, confirm, then live
```

`add` resolves the connector from the registry, shows you a pre-enable preview and a static scan, prompts for any secret with no echo, and only writes the connector to your `claude` config after you confirm.

## The bundled registry

The curated set ships in [config/connectors.json](https://github.com/Grandillionaire/urfael/blob/main/config/connectors.json): GitHub, GitLab, local git, filesystem, Sentry, Linear, Atlassian, Postgres, SQLite, Notion, Slack, Stripe, AWS, the search engines, several vector stores, and more. Point `URFAEL_CONNECTORS_INDEX` at your own JSON (same schema) to replace it.

The parser is fail-soft. A malformed or hostile registry can only ever yield fewer connectors, never a malformed command. Each entry is validated and dropped if it is not shaped right: the id is forced to kebab case, the transport must be one of `npx`, `uvx`, `http`, or `sse`, an `npx`/`uvx` package must be a bare package token with no shell metacharacters, and an `http`/`sse` url must be `https` or an explicit loopback host. Secret env names must match `^[A-Z][A-Z0-9_]*$`, so a registry cannot smuggle a flag in where a key name is expected.

## The pre-enable preview and static scan

Before anything is written, the preview (`app/connectors.js`, `preview()`) reports what the connector is, where it connects and over what protocol, whether it runs third-party code on your machine (`runsLocalCode` is true for `npx` and `uvx`), and which secrets it needs. It also renders the exact `claude mcp add` command, with every secret value already masked.

The static scan (`scan()`) runs over the resolved entry and returns flags at three levels:

- `danger`: an `http`/`sse` endpoint that would send credentials over plain http instead of https.
- `warn`: a stdio connector runs a third-party package on your machine, and any connector whose package or endpoint was not independently verified (`verified: false`). The note tells you to confirm the source before you confirm the add.
- `info`: a loopback service that talks only to your machine, an outbound host, or a secret you will be prompted for.

The scan is a heuristic. It narrows the risk, it does not certify the package. The real guarantee is the preview plus your confirmation, the same as with skills.

## Masked secrets, never in shell history

A secret you type is read with no echo. Urfael builds the `claude mcp add` invocation as an argv array (`buildAddArgs()`), never a shell string, and the caller runs it with `execFile`. The key is interpolated into an `--env KEY=value` or `--header Authorization: Bearer ...` element of that array, so it never touches your interactive shell. It does not land in `~/.zsh_history` and does not show up as a shell line in `ps`. For display and logs, `redactArgs()` masks every secret value while keeping the key name, so a preview can show the command shape without printing a token.

Most connectors in the registry use OAuth or a local grant and need no secret at all. OAuth is handled interactively by the `claude` MCP client in your browser, and no key is stored by Urfael.

## Owner turns only, no restart

A connector is real power, so it loads only on your trusted local turns. Every sandboxed spawn (remote messages, cron jobs, the heartbeat) runs with `--strict-mcp-config`, which loads no connectors. So an injected instruction like "use the GitHub connector to leak a token" has no connector to reach for. `ownerTurnsOnly` is always true in the preview, by design.

Adding a connector does not require a restart. The brain picks it up on your next owner turn.

This path is frozen as a security benchmark check (class 9), so a future change cannot quietly reopen it.

## Read the code

The connector logic is pure and unit-tested: it parses the registry, builds the argv, masks secrets, and produces the preview, while the actual spawn and the no-echo prompt live in the CLI. Read it at [app/connectors.js](https://github.com/Grandillionaire/urfael/blob/main/app/connectors.js).

## Related

- [features/plugins.md](features/plugins.md)
- [features/skills.md](features/skills.md)
- [using/configuration.md](using/configuration.md)
