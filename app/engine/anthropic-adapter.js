'use strict';
// app/engine/anthropic-adapter.js — the native engine's Anthropic Messages API client.
//
// The API-KEY path only. The flat-rate subscription path stays the claude CLI engine (app/session.js) — this
// adapter never touches OAuth or the CLI login, so the "no API key required" default is untouched. Same
// engine-neutral shapes and the same security contract as openai-adapter.js: zero-dep, network-only, no logging,
// endpoint rule re-checked here, redirects refused, bounded accumulation, promise NEVER rejects.
//
// Wire differences owned here so the loop never sees them:
//   - system messages leave the history and ride the top-level `system` param,
//   - assistant toolCalls → content blocks [{type:'tool_use', id, name, input:<object>}] (args string parsed,
//     fail-soft {} — a malformed historical args must not fail the whole request),
//   - tool results → a USER message of [{type:'tool_result', tool_use_id, content}],
//   - streaming: message_start (input tokens) → content_block_start/delta/stop per block (text_delta /
//     input_json_delta) → message_delta (stop_reason, output tokens) → message_stop,
//   - stop_reason map: end_turn/stop_sequence→stop, tool_use→tool_calls, max_tokens→length.

const { createSseParser } = require('./sse');
const { isLoopback } = require('./openai-adapter');

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_TOOL_ARGS = 512 * 1024;
const MAX_EVENT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 8192;               // the API REQUIRES max_tokens; a sane ceiling when the caller has no opinion

function endpointFor(baseUrl) {
  let u; try { u = new URL(String(baseUrl || DEFAULT_BASE)); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) return null;
  const base = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');   // registry rows may carry /v1 — the API path owns it
  u.pathname = base + '/v1/messages';
  u.search = ''; u.hash = '';
  return u;
}

// toWire — engine-neutral history → {system, messages} in Anthropic block shape. Pure.
function toWire(messages) {
  let system = '';
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m && typeof m.role === 'string' ? m.role : 'user';
    const content = String(m && m.content == null ? '' : (m && m.content));
    if (role === 'system') { system += (system ? '\n\n' : '') + content; continue; }
    if (role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(m.toolCallId || ''), content }] });
      continue;
    }
    if (role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const blocks = [];
      if (content) blocks.push({ type: 'text', text: content });
      for (const c of m.toolCalls) {
        let input = {}; try { input = JSON.parse(String(c.args || '{}')); } catch {}   // fail-soft: history replay must not 400
        if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
        blocks.push({ type: 'tool_use', id: String(c.id || ''), name: String(c.name || ''), input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
  }
  return { system, messages: out };
}

// chat(opts) — one streamed Messages turn; same signature + result shape as openai-adapter.chat. NEVER rejects.
function chat(opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    let text = '';
    const usage = { inTok: 0, outTok: 0 };
    const toolCalls = [];                       // completed in block order; blocks arrive sequentially
    let openTool = null;                        // the tool_use block currently streaming its input_json_delta
    let stopReason = '';
    let argBytes = 0, eventBytes = 0;
    let done = false;
    let timer = null;
    let req = null;
    const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
    const fail = (error, sr) => finish({ ok: false, text, toolCalls: [], usage, stopReason: sr || 'error', error });
    const kill = () => { try { if (req) req.destroy(); } catch {} };

    const endpoint = endpointFor(o.baseUrl);
    if (!endpoint) return fail('invalid or disallowed base URL');
    if (!o.model) return fail('no model');
    if (!o.apiKey) return fail('anthropic engine needs an API key (the subscription path is the claude CLI engine)');

    const { system, messages } = toWire(o.messages);
    const body = JSON.stringify({
      model: String(o.model),
      ...(system ? { system } : {}),
      messages,
      ...(Array.isArray(o.tools) && o.tools.length
        ? { tools: o.tools.map((t) => ({ name: String(t.name || ''), description: String(t.description || ''), input_schema: (t.parameters && typeof t.parameters === 'object') ? t.parameters : { type: 'object', properties: {} } })) }
        : {}),
      max_tokens: Math.max(1, (o.maxTokens | 0) || DEFAULT_MAX_TOKENS),
      ...(typeof o.temperature === 'number' ? { temperature: o.temperature } : {}),
      stream: true,
    });

    const parser = createSseParser((data, ev) => {
      if (done) return;
      let j; try { j = JSON.parse(data); } catch { return; }
      const type = String((j && j.type) || ev || '');
      if (type === 'message_start') {
        const u = j.message && j.message.usage;
        if (u) usage.inTok = u.input_tokens | 0;
      } else if (type === 'content_block_start') {
        const b = j.content_block || {};
        if (b.type === 'tool_use') openTool = { id: String(b.id || ''), name: String(b.name || ''), args: '' };
      } else if (type === 'content_block_delta') {
        const d = j.delta || {};
        if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          text += d.text;
          if (text.length > MAX_TEXT) { kill(); return fail('response text exceeded cap', 'length'); }
          if (typeof o.onDelta === 'function') { try { o.onDelta(d.text); } catch {} }
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          if (openTool) {
            openTool.args += d.partial_json;
            argBytes += d.partial_json.length;
            if (argBytes > MAX_TOOL_ARGS) { kill(); return fail('tool-call arguments exceeded cap'); }
          }
        }
      } else if (type === 'content_block_stop') {
        if (openTool) { toolCalls.push({ id: openTool.id, name: openTool.name, args: openTool.args || '{}' }); openTool = null; }
      } else if (type === 'message_delta') {
        if (j.delta && j.delta.stop_reason) stopReason = String(j.delta.stop_reason);
        if (j.usage) usage.outTok = j.usage.output_tokens | 0;
      } else if (type === 'error') {
        kill();
        return fail('api error: ' + String((j.error && j.error.message) || 'unknown').slice(0, 300));
      }
      // message_stop / ping: nothing to do — the response 'end' finishes the turn
    });

    const mod = endpoint.protocol === 'https:' ? require('https') : require('http');
    const headers = {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      Accept: 'text/event-stream',
      'x-api-key': o.apiKey,                    // the ONLY place the key exists
      'anthropic-version': '2023-06-01',
    };

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
        if (openTool) { toolCalls.push({ id: openTool.id, name: openTool.name, args: openTool.args || '{}' }); openTool = null; }   // truncated stream: keep what arrived
        const sr = toolCalls.length ? 'tool_calls' : (stopReason === 'max_tokens' ? 'length' : 'stop');
        finish({ ok: true, text, toolCalls, usage, stopReason: sr });
      });
      res.on('error', (e) => fail(String((e && e.message) || e)));
    });

    timer = setTimeout(() => { kill(); fail('turn timed out'); }, o.timeoutMs || DEFAULT_TIMEOUT_MS);

    if (o.signal) {
      if (o.signal.aborted) { kill(); return fail('aborted', 'aborted'); }
      o.signal.addEventListener('abort', () => { kill(); fail('aborted', 'aborted'); }, { once: true });
    }
    req.on('error', (e) => fail(String((e && e.message) || e)));
    req.end(body);
  });
}

module.exports = { chat, endpointFor, toWire };
