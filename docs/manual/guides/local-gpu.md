# Run on your own GPU

By default Urfael runs on your Claude subscription. It can also run entirely on your own hardware: a local model for the brain, a local model for the embedder. No cloud, no per-token meter, nothing leaving the machine. The voice, memory, recall, skills, scheduling, and the security model are unchanged. Only the brain changes.

Be honest about the tradeoff. A local 7B to 70B model is not Claude. Expect weaker reasoning, weaker code, shorter effective context, and slower responses on consumer GPUs. Run local for privacy and sovereignty. Run on Claude for capability. You can keep both and switch with one env var.

## The brain

Urfael's brain shells out to the `claude` CLI, and Claude Code's backend is set by environment variables. Claude Code speaks the Anthropic Messages API; local engines (Ollama, LM Studio, NVIDIA NIM) speak the OpenAI API. So you put a small translating proxy in between (claude-code-router or LiteLLM), and point the CLI at it.

`urfael setup` walks you through this. Choose "Local model / custom", pick a proxy preset or paste a URL, and it writes the routing vars. The vars it manages:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3456   # your translating proxy
ANTHROPIC_AUTH_TOKEN=local                 # any non-empty value; local proxies ignore it
URFAEL_OPUS_MODEL=qwen2.5:32b-instruct     # map Urfael's tiers to your local model(s)
URFAEL_SONNET_MODEL=qwen2.5:14b-instruct
```

Setting `ANTHROPIC_BASE_URL` flips the daemon into local mode. The daemon forwards these vars to every path it spawns (live turns, remote and chat turns, cron jobs, the heartbeat, memory distillation), so the whole system goes local, not just the foreground chat. The cost meter reads $0 because the Anthropic meter no longer applies.

## The embedder

Recall is lexical BM25 by default. If you point Urfael at a local embeddings endpoint, recall upgrades to semantic: past turns surface by meaning, not just shared words. This is opt-in and off by default.

`urfael setup` asks for an optional OpenAI-compatible `/v1/embeddings` URL. It sets:

```bash
URFAEL_EMBED_URL=http://127.0.0.1:11434/v1/embeddings
URFAEL_EMBED_MODEL=nomic-embed-text        # the default if you leave it blank
```

`URFAEL_EMBED_KEY` is also read if your endpoint needs a bearer token. The client is fail-soft by contract: any error (endpoint down, bad response, timeout) returns null and recall falls back to BM25. It never throws, and nothing leaves the box. History indexes locally and lazily as you recall.

## What is already local

- Speech-to-text: whisper.cpp, on-device, the default.
- Text-to-speech: macOS `say` or Linux `espeak-ng`, or local Kokoro. No cloud TTS.
- Memory, recall, skills, the dashboard, and the channels: local already.

With a local brain and the default local voice, nothing leaves the machine. The security model does not widen: the daemon still opens no port, remote turns stay read-only with no egress, and the credential-store deny still holds. The only credential forwarded to the sandboxed children is the proxy's (usually a dummy `local` token), and the untrusted profile has no tool to exfiltrate it.

Check your mode with `urfael status`. Switch any time by setting or unsetting `ANTHROPIC_BASE_URL` and restarting the daemon. See also features/memory.md for how recall works and start/quickstart.md to get running.

## Full guide

The engineering doc covers the proxy setup in detail, the NVIDIA NIM path, where to put the env vars for the LaunchAgent or systemd unit, and the security reasoning: [docs/LOCAL-GPU.md](https://github.com/Grandillionaire/urfael/blob/main/docs/LOCAL-GPU.md).
