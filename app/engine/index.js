'use strict';
// app/engine/index.js — assemble a native engine from a provider entry + daemon collaborators.
//
// This is the ONE integration surface the daemon calls. Given a validated provider registry entry (app/providers.js),
// its secret, and the daemon's own capabilities (recall, memory append, the vault-cwd runShell), it picks the right
// transport adapter, wires the fail-closed toolset and the compactor (whose aux-summarizer is a cheap call back
// through the same adapter), and returns a ready { run } engine.
//
// Adapter selection mirrors providers.js semantics:
//   • entry.kind === 'anthropic' AND no custom baseUrl  → the Anthropic Messages adapter against the cloud (API key).
//   • entry.kind === 'anthropic' WITH a baseUrl, or 'openai'/'gemini'/'ollama'/custom → the OpenAI-compatible adapter
//     pointed at the baseUrl (this is how Ollama/LM Studio/vLLM/OpenRouter/most clouds are reached).
// The flat-rate SUBSCRIPTION provider (kind 'anthropic', no baseUrl, authKind 'none') is intentionally NOT engine-able
// here — that path stays the `claude` CLI engine (app/session.js), so "no API key" keeps working. buildEngine returns
// null for it, and the daemon falls back to the CLI spawn. That fallback is the hybrid.

const openai = require('./openai-adapter');
const anthropic = require('./anthropic-adapter');
const { createToolset } = require('./tools');
const { createCompactor } = require('./compactor');
const { createEngine } = require('./loop');

// pickAdapter(entry) — { adapter, baseUrl } or null when this entry must stay on the CLI engine.
function pickAdapter(entry) {
  if (!entry) return null;
  const kind = String(entry.kind || '');
  const baseUrl = String(entry.baseUrl || '');
  if (kind === 'anthropic' && !baseUrl) {
    if (entry.authKind === 'none') return null;              // the subscription path — CLI engine owns it
    return { adapter: anthropic, baseUrl: '' };              // API-key Anthropic cloud
  }
  if (baseUrl) return { adapter: openai, baseUrl };          // any OpenAI-compatible endpoint (incl. anthropic-with-baseurl proxies via the compat shape)
  return null;
}

// makeSummarizer(adapter, modelCfg) — the compactor's injected aux-model summary. It renders the middle window to a
// compact transcript and asks the (ideally cheap) model for a structured summary, folding in any prior summary. Fully
// fail-soft: ANY adapter failure returns { ok:false } so the compactor takes its fail-safe abort (window preserved).
function makeSummarizer(adapter, modelCfg) {
  return async function summarize(middle, prior) {
    const transcript = middle.map((m) => {
      const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'ToolResult' : m.role;
      let line = who + ': ' + String(m.content == null ? '' : m.content);
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) line += ' [called: ' + m.toolCalls.map((c) => c.name).join(', ') + ']';
      return line;
    }).join('\n').slice(0, 60000);   // bound the prompt; the middle is already token-bounded but a hostile tool result could be huge
    const instruction =
      'Condense the following conversation excerpt into a compact, factual summary that preserves decisions, ' +
      'open questions, file paths, names, numbers, and any task state. Omit pleasantries. Write in terse notes, ' +
      'not prose.' + (prior ? ' First, an earlier summary to MERGE and carry forward:\n' + prior + '\n\nNow the newer excerpt:\n' : '\n\n');
    const res = await adapter.chat({
      baseUrl: modelCfg.baseUrl, apiKey: modelCfg.apiKey, model: modelCfg.summaryModel || modelCfg.model,
      messages: [
        { role: 'system', content: 'You are a precise conversation summarizer. Output only the summary.' },
        { role: 'user', content: instruction + transcript },
      ],
      maxTokens: 1024, temperature: 0,
    });
    if (!res || !res.ok || !res.text || !res.text.trim()) return { ok: false };
    return { ok: true, summary: res.text.trim(), kind: 'aux_model' };
  };
}

// buildEngine(spec) — the daemon's entry point. Returns { run } or null (⇒ use the CLI engine for this provider).
//   spec = { entry, secret, model, vaultDir, memoryDir?, workspaceDir?, allowShell?, runShell?, recall?,
//            appendMemory?, maxTokens?, maxSteps?, summaryModel?, onDelta?, onThinking?, now? }
function buildEngine(spec) {
  spec = spec || {};
  const pick = pickAdapter(spec.entry);
  if (!pick) return null;
  // TRIM the secret: a key read from a file/env commonly carries a trailing newline, which would make http.request
  // reject the header value synchronously. Trimming here (plus the adapters' try-wrap) closes that off at the source.
  const apiKey = String(spec.secret == null ? '' : spec.secret).trim();
  // an API-key adapter with no key must NOT silently answer on some other credential — refuse to build, so the
  // daemon surfaces "set the key" exactly like the CLI engine's fail-closed provider path does.
  if (!apiKey) return { needsSecret: true, authEnv: spec.entry && spec.entry.authEnv };

  const modelCfg = { baseUrl: pick.baseUrl, apiKey, model: spec.model, summaryModel: spec.summaryModel };
  const toolset = createToolset({
    vaultDir: spec.vaultDir, memoryDir: spec.memoryDir, workspaceDir: spec.workspaceDir,
    allowShell: spec.allowShell, runShell: spec.runShell, recall: spec.recall, appendMemory: spec.appendMemory,
  });
  const compactor = createCompactor({ summarize: makeSummarizer(pick.adapter, modelCfg), now: spec.now });
  const engine = createEngine({
    adapter: pick.adapter, toolset, compactor,
    model: spec.model, apiKey, baseUrl: pick.baseUrl,
    maxTokens: spec.maxTokens, contextWindow: spec.contextWindow, maxSteps: spec.maxSteps,
    onDelta: spec.onDelta, onThinking: spec.onThinking, now: spec.now,
  });
  return { run: engine.run, toolset, _adapter: pick.adapter === anthropic ? 'anthropic' : 'openai' };
}

module.exports = { buildEngine, pickAdapter, makeSummarizer };
