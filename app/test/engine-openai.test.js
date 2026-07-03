'use strict';
// Unit tests for the native engine's SSE parser + OpenAI-compatible adapter. The adapter is exercised against a
// REAL loopback node:http server (loopback plain-http is the adapter's own allowed case, so the test transport is
// the production transport), driving the exact framing quirks the wild exposes: split events across TCP chunks,
// CRLF lines, indexed tool-call fragments, the [DONE] marker, redirects (must be refused), oversized streams
// (must fail closed), and a hung server (the watchdog must fire and the promise must still resolve).
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSseParser } = require('../engine/sse');
const adapter = require('../engine/openai-adapter');

// ---- sse.js -------------------------------------------------------------------------------------

test('sse: reassembles an event split across arbitrary chunk boundaries', () => {
  const got = [];
  const p = createSseParser((data, ev) => got.push({ data, ev }));
  const raw = 'event: message\ndata: {"a":1}\n\ndata: two\ndata: lines\n\n';
  for (const ch of raw) p.feed(ch);                       // worst case: one byte at a time
  assert.deepStrictEqual(got, [{ data: '{"a":1}', ev: 'message' }, { data: 'two\nlines', ev: '' }]);
});

test('sse: CRLF framing, comments, and a final unterminated event flushed by end()', () => {
  const got = [];
  const p = createSseParser((data) => got.push(data));
  p.feed('data: a\r\n\r\n: keep-alive ping\r\ndata: tail');
  assert.deepStrictEqual(got, ['a']);                     // the tail event is still open
  p.end();
  assert.deepStrictEqual(got, ['a', 'tail']);
  p.end();                                                // idempotent
  assert.deepStrictEqual(got, ['a', 'tail']);
});

// ---- endpoint rule (the SSRF-adjacent gate) ------------------------------------------------------

test('endpointFor: https remote ok, plain-http remote refused, loopback http ok, creds-in-URL refused', () => {
  assert.ok(adapter.endpointFor('https://api.example.com/v1'));
  assert.strictEqual(adapter.endpointFor('http://api.example.com/v1'), null);          // plain-http remote: never
  assert.ok(adapter.endpointFor('http://127.0.0.1:11434/v1'));                          // Ollama
  assert.ok(adapter.endpointFor('http://localhost:1234/v1/'));                          // LM Studio, trailing slash
  assert.strictEqual(adapter.endpointFor('https://user:pw@api.example.com/v1'), null);  // smuggled credentials
  assert.strictEqual(adapter.endpointFor('not a url'), null);
  const u = adapter.endpointFor('http://127.0.0.1:9/v1/');
  assert.strictEqual(u.pathname, '/v1/chat/completions');                               // path derived, query dropped
});

// ---- adapter against a live loopback server ------------------------------------------------------

// serve(handler) — a one-shot loopback server; returns {port, close}. Each test drives its own framing.
function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
  });
}
const sse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

test('adapter: streams text deltas, accumulates indexed tool-call fragments, reports usage', async () => {
  const { port, close } = await serve((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body);
      assert.strictEqual(j.stream, true);
      assert.strictEqual(j.messages[0].role, 'system');                 // wire conversion reached the server
      assert.strictEqual(j.tools[0].function.name, 'read_file');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { content: 'Hel' } }] });
      sse(res, { choices: [{ delta: { content: 'lo' } }] });
      // a tool call split into three indexed fragments — id first, then the name, then the args in two pieces
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.md"}' } }] }, finish_reason: 'tool_calls' }] });
      sse(res, { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const deltas = [];
  const r = await adapter.chat({
    baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'm',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    onDelta: (t) => deltas.push(t),
  });
  await close();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'Hello');
  assert.deepStrictEqual(deltas, ['Hel', 'lo']);
  assert.strictEqual(r.stopReason, 'tool_calls');
  assert.deepStrictEqual(r.toolCalls, [{ id: 'c1', name: 'read_file', args: '{"path":"a.md"}' }]);
  assert.deepStrictEqual(r.usage, { inTok: 42, outTok: 7 });
});

test('adapter: assistant toolCalls + tool results round-trip through the wire shape', async () => {
  let seen;
  const { port, close } = await serve((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] });
      res.end();
    });
  });
  const r = await adapter.chat({
    baseUrl: 'http://127.0.0.1:' + port, model: 'm',
    messages: [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"a.md"}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'file body' },
    ],
  });
  await close();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(seen.messages[1].tool_calls[0].function.arguments, '{"path":"a.md"}');
  assert.strictEqual(seen.messages[2].role, 'tool');
  assert.strictEqual(seen.messages[2].tool_call_id, 'c1');
  assert.strictEqual(r.stopReason, 'stop');
});

test('adapter: a redirect is REFUSED, never followed', async () => {
  let followed = false;
  const { port, close } = await serve((req, res) => {
    if (req.url.includes('elsewhere')) { followed = true; }
    res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' });
    res.end();
  });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, model: 'm', messages: [{ role: 'user', content: 'x' }] });
  await close();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /redirect refused/);
  assert.strictEqual(followed, false);
});

test('adapter: non-200 resolves a bounded classified failure (never rejects, no key echo)', async () => {
  const { port, close } = await serve((req, res) => {
    assert.strictEqual(req.headers.authorization, 'Bearer sk-test');   // the key reached the header...
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, model: 'm', apiKey: 'sk-test', messages: [{ role: 'user', content: 'x' }] });
  await close();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /HTTP 401/);
  assert.ok(!r.error.includes('sk-test'));                             // ...and never the result
});

test('adapter: a hung server hits the watchdog — the promise still resolves', async () => {
  const { port, close } = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); /* then silence */ });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, model: 'm', messages: [{ role: 'user', content: 'x' }], timeoutMs: 200 });
  await close();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('adapter: an abort signal resolves stopReason aborted', async () => {
  const ac = new AbortController();
  const { port, close } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { choices: [{ delta: { content: 'partial' } }] });
    setTimeout(() => ac.abort(), 50);                                  // abort mid-stream
  });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, model: 'm', messages: [{ role: 'user', content: 'x' }], signal: ac.signal });
  await close();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stopReason, 'aborted');
  assert.strictEqual(r.text, 'partial');                               // partial text is preserved for the caller
});

test('adapter: an endpoint that streams past the byte cap fails CLOSED, not OOM', async () => {
  const { port, close } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // a runaway stream: fat keep-alive comment lines never form an event, so only the byte cap can stop them
    const blob = ': ' + 'x'.repeat(65536) + '\n';
    (function pump() { if (res.writableEnded) return; if (res.write(blob.repeat(16))) setImmediate(pump); else res.once('drain', pump); })();
  });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, model: 'm', messages: [{ role: 'user', content: 'x' }], timeoutMs: 60000 });
  await close();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /byte cap/);
});

test('adapter: a malformed SSE event is dropped, the turn still completes', async () => {
  const { port, close } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {not json}\n\n');
    sse(res, { choices: [{ delta: { content: 'fine' }, finish_reason: 'stop' }] });
    res.end();
  });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, model: 'm', messages: [{ role: 'user', content: 'x' }] });
  await close();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'fine');
});
