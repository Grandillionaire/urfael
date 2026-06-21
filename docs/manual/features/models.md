# Models & providers

The brain is your installed `claude` CLI. Urfael does not host weights and runs no inference of its own. Every model choice is really a choice of which backend that CLI talks to. There are two layers: the tier you pin inside the active backend, and the backend (provider) itself.

## Tiers inside a provider

By default Urfael auto-routes between Claude Code's model aliases: `sonnet` for most turns, escalating to `opus` for code and deep reasoning. Because it uses aliases, it tracks the latest models your plan supports.

```bash
urfael model           # show the current routing (auto, or what it is pinned to)
urfael model opus      # pin every turn to the big tier
urfael model sonnet    # pin every turn to the small tier
urfael model auto      # unpin, back to auto-routing
```

The same switch works verbally in chat ("switch to opus", "go back to auto"). Opus needs a **Max** plan. On **Pro**, set `URFAEL_OPUS_MODEL=sonnet` so the escalation lands on a model your plan allows. The tier pin applies within whatever provider is currently active.

## Providers: any model on your own key or hardware

The Claude flat-rate subscription is the default provider (`id=claude`) and the thesis of the project: native cloud, no API key, $0 marginal cost. You can switch the backend to a non-Anthropic or local model through a translating proxy. Urfael does this by managing the routing environment variables that the `claude` CLI already reads (mainly `ANTHROPIC_BASE_URL` and an auth token), not by hosting anything.

```bash
urfael model providers              # list the curated registry, marking the active one
urfael model use <id>               # preview, then switch (writes provider.env 0600, restarts the daemon)
urfael model test <id>              # probe a provider with a one-line prompt before relying on it
urfael model route --for cost       # recommend the best provider for a priority (see Routing below)
```

`urfael model use` shows a preview first: the target endpoint, the model each tier maps to, the proxy hint, and any secret it needs. A `key`-auth provider prompts for the secret with no echo. Nothing is written until you confirm. The switch then writes `provider.env` (mode `0600`) and restarts the daemon so every spawn re-sources it. Live turns, chat, cron, and the heartbeat all move to the new backend, not just the foreground.

The curated registry ships in [config/providers.json](https://github.com/Grandillionaire/urfael/blob/main/config/providers.json) with **30 named providers**: Claude (native, Bedrock, Vertex), OpenAI, Azure, Gemini, xAI Grok, GitHub Copilot, OpenRouter, DeepSeek, Mistral, Groq, Cerebras, Fireworks, Together, Perplexity, NVIDIA NIM, Novita, Hugging Face, Qwen, Kimi, GLM, MiniMax, the local servers (Ollama, LM Studio, vLLM, llama.cpp, Jan), and the proxies (claude-code-router, LiteLLM). OpenRouter alone reaches 300+ models on one key, so the total reach matches the broadest agents, while staying honest that reach is not hosting. Point `URFAEL_PROVIDERS_INDEX` at your own JSON (same schema) to replace it.

## Routing: the right provider for the job

`urfael model route` recommends a provider for a priority, then shows the honest tradeoffs.

```bash
urfael model route --for cost       # cheapest that still works
urfael model route --for speed      # highest throughput
urfael model route --for quality    # most capable
urfael model route --for privacy    # best local model, nothing leaves the machine
urfael model route --for balanced --ctx 100000 --tools
```

Each registry row carries indicative 1-5 tiers for cost, speed, and quality. The router is **Pareto-aware**: instead of sorting on one axis like a price list, it returns the whole non-dominated frontier (the genuine tradeoffs), then picks the best for your priority and explains why. It stays honest: it flags when a tier is unknown, notes that a local model is weaker, and reminds you that the flat-rate Claude subscription is `$0` marginal for a subscriber and may be cheaper in practice than any per-token provider. The tiers are indicative, not benchmarks. Routing **recommends**; it never switches on its own, because a switch needs your key and a restart. Run the `urfael model use <id>` it prints to actually move.

### Most non-Claude backends need a proxy

Claude Code speaks the Anthropic Messages API. To reach a GPT-, Gemini-, or OpenAI-shaped endpoint you usually need a translating proxy ([claude-code-router](https://github.com/musistudio/claude-code-router) or [LiteLLM](https://docs.litellm.ai/)) that presents the Anthropic shape and converts. You run and secure that proxy yourself; Urfael just points the brain at it. Each non-native registry row carries its own `proxyHint`, shown in the preview.

The safety harness is unchanged by the provider switch. Allowlisting, the read-only remote sandbox, fail-closed profiles, and the adversarial regression tests all sit between the channel and the brain, so they apply whatever model is behind the CLI. See [security/model.md](security/model.md).

## Honest tradeoffs

- **You pay for non-Anthropic models.** The Claude subscription only covers Anthropic models. Anything else (OpenRouter, DeepSeek, a local server) runs on **your own provider key or your own hardware**, billed to you.
- **A local model is not Claude.** Weaker reasoning and code, shorter effective context, slower on consumer GPUs. The registry says this plainly in its `_honesty` note.
- **`ANTHROPIC_API_KEY` overrides the subscription.** If that variable is in your environment, the CLI uses it (metered) instead of your flat-rate login.
- **Most registry rows are `•unverified`.** That flag means the endpoint and model ids were not pinned at research time, not that they are broken. Confirm the base URL and model ids in the preview, and run `urfael model test <id>`, before relying on one.

Native, non-CLI provider support is not a goal. It would mean dropping the `claude`-CLI harness that keeps Urfael fast, free on your plan, and on the right side of Anthropic's terms.

For a fully local, air-gapped setup (Ollama / LM Studio / vLLM via that same proxy, plus the already-local voice), see [guides/local-gpu.md](guides/local-gpu.md). The provider engine itself is pure and unit-tested; read it at [app/providers.js](https://github.com/Grandillionaire/urfael/blob/main/app/providers.js).

## Related

- [guides/local-gpu.md](guides/local-gpu.md)
- [security/model.md](security/model.md)
- [using/configuration.md](using/configuration.md)
