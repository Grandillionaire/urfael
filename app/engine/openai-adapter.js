'use strict';
// app/engine/openai-adapter.js — the native engine's OpenAI-compatible /chat/completions client.
//
// One adapter covers everything that speaks the de-facto standard: Ollama, LM Studio, vLLM, llama.cpp server,
// OpenRouter, Groq, DeepSeek, Mistral, and most clouds. Zero-dep (node http/https only), no streaming SDK.
// This module does NETWORK ONLY — no fs, no spawn, no logging (the caller logs classified failures; a raw
// error line here could leak a key or a prompt into urfael.log).
//
// SECURITY CONTRACT (load-bearing):
//   - Endpoint rule mirrors app/providers.js: HTTPS for anything remote; plain http ONLY on loopback (local
//     models). A registry row that slipped past that gate still can't make this adapter talk plain-http to a
//     remote host — the rule is re-checked here at request time (belt + suspenders).
//   - Redirects are NEVER followed. A 3xx resolves the turn as a refusal — a compromised local proxy must not
//     be able to bounce a prompt (or the Authorization header) to a host of its choosing.
//   - The API key exists ONLY in the Authorization header of this one request object. It is never stored on
//     the adapter, never echoed into the result, and this module never logs.
//   - The response is BOUNDED (text + tool-call args + raw event bytes). An endpoint that streams forever or
//     returns a gigabyte of "arguments" fails the turn closed instead of OOMing the daemon.
//   - The promise NEVER rejects. Every failure resolves {ok:false, error, stopReason:'error'} so a thrown
//     turn can't land in the daemon's shared chain unhandled (the exact class of bug the chain .catch fixed).
//
// Engine-neutral shapes (shared with anthropic-adapter.js, loop.js, compactor.js):
//   message  : {role:'system'|'user'|'assistant'|'tool', content:string,
//               toolCalls?:[{id,name,args}], toolCallId?:string}   (args = RAW JSON string, parsed by the loop)
//   tool def : {name, description, parameters}                      (parameters = JSON Schema object)
//   result   : {ok, text, toolCalls:[{id,name,args}], usage:{inTok,outTok}, stopReason, error?}
//               stopReason ∈ 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error'

const { createSseParser } = require('./sse');

const MAX_TEXT = 2 * 1024 * 1024;        // accumulated assistant text cap
const MAX_TOOL_ARGS = 512 * 1024;        // accumulated tool-call arguments cap (all calls combined)
const MAX_EVENT_BYTES = 32 * 1024 * 1024; // raw SSE byte cap for one turn — backstop against a runaway stream
const DEFAULT_TIMEOUT_MS = 300000;       // one whole turn, matching the daemon's cron watchdog

function isLoopback(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// endpointFor — validate the base URL and derive the chat-completions endpoint. Returns null on ANY rule
// violation (bad parse, plain-http remote, credentials smuggled into the URL) — the caller fails the turn closed.
function endpointFor(baseUrl) {
  let u; try { u = new URL(String(baseUrl || '')); } catch { return null; }
  if (u.username || u.password) return null;                       // no credentials-in-URL, ever
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) return null;
  const base = u.pathname.replace(/\/+$/, '');                     // tolerate a trailing slash on the registry row
  u.pathname = base + '/chat/completions';
  u.search = ''; u.hash = '';
  return u;
}

// toWire — engine-neutral messages/tools → the OpenAI wire shape. Pure; drops nothing silently (an unknown
// role becomes 'user' content so a malformed history degrades to visible text instead of vanishing).
function toWire(messages, tools) {
  const wireMsgs = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m && typeof m.role === 'string' ? m.role : 'user';
    if (role === 'tool') {
      wireMsgs.push({ role: 'tool', tool_call_id: String(m.toolCallId || ''), content: String(m.content == null ? '' : m.content) });
    } else if (role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      wireMsgs.push({
        role: 'assistant',
        content: String(m.content == null ? '' : m.content) || null,
        tool_calls: m.toolCalls.map((c) => ({ id: String(c.id || ''), type: 'function', function: { name: String(c.name || ''), arguments: String(c.args == null ? '' : c.args) } })),
      });
    } else {
      wireMsgs.push({ role: role === 'system' || role === 'assistant' ? role : 'user', content: String(m && m.content == null ? '' : (m && m.content)) });
    }
  }
  const wireTools = Array.isArray(tools) && tools.length
    ? tools.map((t) => ({ type: 'function', function: { name: String(t.name || ''), description: String(t.description || ''), parameters: (t.parameters && typeof t.parameters === 'object') ? t.parameters : { type: 'object', properties: {} } } }))
    : undefined;
  return { wireMsgs, wireTools };
}

// chat(opts) — one streamed completion turn. Resolves the engine-neutral result; NEVER rejects.
//   opts: { baseUrl, apiKey, model, messages, tools, maxTokens, temperature, timeoutMs, onDelta(text), signal }
function chat(opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    // state FIRST — finish/fail close over these, and fail can run before the request is even built
    let text = '';
    const usage = { inTok: 0, outTok: 0 };
    const callsByIndex = new Map();              // OpenAI streams tool calls as indexed fragments
    let finishReason = '';
    let argBytes = 0, eventBytes = 0;
    let done = false;
    let timer = null;                            // the turn watchdog — armed after the request is created
    let req = null;                              // the in-flight request — parser callbacks destroy it on caps
    const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
    const fail = (error, stopReason) => finish({ ok: false, text, toolCalls: [], usage, stopReason: stopReason || 'error', error });
    const kill = () => { try { if (req) req.destroy(); } catch {} };

    const endpoint = endpointFor(o.baseUrl);
    if (!endpoint) return fail('invalid or disallowed base URL');
    if (!o.model) return fail('no model');

    const { wireMsgs, wireTools } = toWire(o.messages, o.tools);
    const body = JSON.stringify({
      model: String(o.model),
      messages: wireMsgs,
      ...(wireTools ? { tools: wireTools } : {}),
      ...(o.maxTokens ? { max_tokens: Math.max(1, o.maxTokens | 0) } : {}),
      ...(typeof o.temperature === 'number' ? { temperature: o.temperature } : {}),
      stream: true,
      stream_options: { include_usage: true },   // fail-soft: servers that ignore it just report usage 0
    });

    const parser = createSseParser((data) => {
      if (done) return;
      if (data === '[DONE]') return;             // terminal marker — the response 'end' finishes the turn
      let j; try { j = JSON.parse(data); } catch { return; }   // one malformed event is dropped, not fatal
      if (j && j.usage) {                        // final usage chunk (stream_options) — may ride any event
        usage.inTok = j.usage.prompt_tokens | 0; usage.outTok = j.usage.completion_tokens | 0;
      }
      const ch = j && Array.isArray(j.choices) ? j.choices[0] : null;
      if (!ch) return;
      if (ch.finish_reason) finishReason = String(ch.finish_reason);
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        if (text.length > MAX_TEXT) { kill(); return fail('response text exceeded cap', 'length'); }
        if (typeof o.onDelta === 'function') { try { o.onDelta(d.content); } catch {} }   // a throwing UI callback must never kill the turn
      }
      if (Array.isArray(d.tool_calls)) {
        for (const frag of d.tool_calls) {
          const i = frag.index | 0;
          const cur = callsByIndex.get(i) || { id: '', name: '', args: '' };
          if (frag.id) cur.id = String(frag.id);
          if (frag.function && frag.function.name) cur.name += String(frag.function.name);
          if (frag.function && typeof frag.function.arguments === 'string') {
            cur.args += frag.function.arguments;
            argBytes += frag.function.arguments.length;
            if (argBytes > MAX_TOOL_ARGS) { kill(); return fail('tool-call arguments exceeded cap'); }
          }
          callsByIndex.set(i, cur);
        }
      }
    });

    const mod = endpoint.protocol === 'https:' ? require('https') : require('http');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'text/event-stream' };
    if (o.apiKey) headers.Authorization = 'Bearer ' + o.apiKey;   // the ONLY place the key exists

    req = mod.request({
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: endpoint.pathname,
      method: 'POST',
      headers,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); kill(); return fail('redirect refused (' + res.statusCode + ')'); }
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (d) => { errBody = (errBody + d).slice(0, 2048); });
        res.on('end', () => fail('HTTP ' + res.statusCode + (errBody ? ': ' + errBody.replace(/\s+/g, ' ').slice(0, 300) : '')));
        res.on('error', (e) => fail(String((e && e.message) || e)));
        return;
      }
      res.on('data', (d) => {
        eventBytes += d.length;
        if (eventBytes > MAX_EVENT_BYTES) { kill(); return fail('stream exceeded byte cap', 'length'); }
        parser.feed(d);
      });
      res.on('end', () => {
        parser.end();
        const toolCalls = [...callsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter((c) => c.name);
        const stopReason = toolCalls.length ? 'tool_calls' : (finishReason === 'length' ? 'length' : 'stop');
        finish({ ok: true, text, toolCalls, usage, stopReason });
      });
      res.on('error', (e) => fail(String((e && e.message) || e)));
    });

    // the turn watchdog — finish() clears it on every resolution path, so it can never fire into a dead turn
    timer = setTimeout(() => { kill(); fail('turn timed out'); }, o.timeoutMs || DEFAULT_TIMEOUT_MS);

    if (o.signal) {
      if (o.signal.aborted) { kill(); return fail('aborted', 'aborted'); }
      o.signal.addEventListener('abort', () => { kill(); fail('aborted', 'aborted'); }, { once: true });
    }
    req.on('error', (e) => fail(String((e && e.message) || e)));
    req.end(body);
  });
}

module.exports = { chat, endpointFor, toWire, isLoopback };
