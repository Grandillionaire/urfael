# Run Urfael 100% on your own GPU — no cloud, no meter

By default Urfael runs on your Claude subscription. But it can also run **entirely on your own hardware** —
a local model on your GPU, local speech-to-text, local text-to-speech. No cloud, no per-token meter, no
data leaving the machine. The same security model, the same surfaces, the same memory — a different brain.

This is the **air-gapped / sovereign** configuration: the assistant on your desk, answerable to no one's API.

> **Honest tradeoff, first.** A 7B–70B local model is **not** Claude. Expect weaker reasoning, weaker code,
> shorter effective context, and slower responses on consumer GPUs. Everything *around* the model — voice,
> memory, recall, skills, scheduling, the security moat — is unchanged. Run local for privacy/sovereignty/
> cost; run on Claude for capability. You can keep both and switch with one env var.

## How it works

Urfael's brain shells out to the official `claude` CLI, and Claude Code's backend is set entirely by
environment variables. So pointing Urfael at a local model means pointing the `claude` CLI at one — and
**Urfael forwards the routing vars to every path it spawns** (your live turns, remote/chat turns, cron jobs,
the heartbeat, memory distillation), so the *whole* system goes local, not just the foreground chat.

Claude Code speaks the **Anthropic Messages API**, and local engines (Ollama, LM Studio, NVIDIA NIM) speak
the **OpenAI** API — so you put a tiny **translating proxy** in between. Two well-worn options:

- **[claude-code-router](https://github.com/musistudio/claude-code-router)** — a local proxy with per-engine
  transformers (Ollama, LM Studio, vLLM, …).
- **[LiteLLM](https://docs.litellm.ai/)** — the gateway Anthropic itself documents; expose its Anthropic-format endpoint.

```
 Urfael daemon ──spawns──▶ claude CLI ──ANTHROPIC_BASE_URL──▶ translating proxy ──▶ Ollama / NIM / vLLM  (your GPU)
       │                                                                                      │
   whisper.cpp (STT, local)                                                          local model weights
   espeak / Kokoro (TTS, local)                                                        (nothing leaves the box)
```

## Setup (Ollama, the simplest)

```bash
# 1. a local model on your GPU
ollama pull qwen2.5:32b-instruct        # or llama3.3:70b, deepseek-r1, etc.

# 2. a proxy that presents the Anthropic API and forwards to Ollama
npm i -g @musistudio/claude-code-router  # then configure it for your Ollama endpoint
ccr start                                 # serves e.g. http://127.0.0.1:3456

# 3. tell Urfael's daemon to use it — set these in the daemon's environment, then restart it.
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=local        # any non-empty value; the local proxy ignores it
export URFAEL_OPUS_MODEL=qwen2.5:32b-instruct   # map Urfael's tiers to your local model(s)
export URFAEL_SONNET_MODEL=qwen2.5:14b-instruct
```

Put those `export`s where the daemon reads them: the macOS LaunchAgent's `EnvironmentVariables` block
(`~/Library/LaunchAgents/com.urfael.daemon.plist`) or the systemd unit's `Environment=` lines, then
`launchctl kickstart -k` / `systemctl --user restart urfael-daemon`. Urfael propagates them to every child.

Verify it's local:

```bash
urfael status        # cost shows $0 and `local: true` — the Anthropic meter is off
```

## NVIDIA NIM (datacenter / workstation GPUs)

[NVIDIA NIM](https://developer.nvidia.com/nim) serves optimized model microservices with an OpenAI-compatible
endpoint. Point the same translating proxy at your NIM endpoint instead of Ollama, then set
`ANTHROPIC_BASE_URL` to the proxy. On an RTX 6000 / L40S / H100-class card you can run a 70B model at usable
latency and keep the whole assistant — voice, memory, scheduling — on-prem.

## What's already local (so you're not adding cloud elsewhere)

- **Speech-to-text:** whisper.cpp, on-device, the default. No change needed.
- **Text-to-speech:** macOS `say` / Linux `espeak-ng`, or local [Kokoro](https://github.com/remsky/Kokoro-FastAPI). No cloud TTS.
- **Memory, recall, skills, the dashboard, the 8 channels:** all local already.

With a local model + the default local voice, **nothing leaves the machine.** Pull the network cable and it
still listens, thinks, and speaks.

## The security model is unchanged

Going local doesn't widen the blast radius — it shrinks it further (no Anthropic round-trip either). The
daemon still opens no port; remote turns are still read-only with no egress; the credential-store deny still
holds; `npm run security` still passes 9/9. The model credential Urfael forwards to its sandboxed children is
just the local proxy's (often a dummy `local` token), and the untrusted profile has no tool to exfiltrate it
with anyway.

## Semantic recall (bonus of running a local model)

If you already run Ollama/LM Studio for the brain, point Urfael at its embeddings endpoint too and recall upgrades from lexical to **semantic** — past turns surface by meaning, not just shared words. `urfael setup` asks for an optional `/v1/embeddings` URL (e.g. `http://127.0.0.1:11434/v1/embeddings`, model `nomic-embed-text`). It indexes locally, lazily, and **falls back to BM25** if the endpoint is down — nothing leaves the box.

## When to use which

| | On your Claude subscription (default) | 100% local on your GPU |
|---|---|---|
| Capability | Claude-grade reasoning/code | weaker; model-dependent |
| Cost | flat subscription | $0 marginal (your power bill) |
| Privacy | Anthropic processes the turn | nothing leaves the box |
| Speed | fast | depends on your GPU |
| Setup | nothing | a proxy + a model |

Switch any time by setting or unsetting `ANTHROPIC_BASE_URL` and restarting the daemon. Same Urfael, your choice of brain.
