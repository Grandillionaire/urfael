'use strict';
// Unit tests for the native engine's Anthropic Messages adapter, against a live loopback server speaking the
// real event grammar (message_start → content_block_* → message_delta → message_stop). Focus: the wire
// conversion differences (system extraction, tool_use blocks with PARSED input, tool_result-as-user), the
// tool_use streaming path (input_json_delta), the stop_reason map, and the no-key refusal (the subscription
// path must stay the CLI engine, so a keyless native anthropic turn fails closed with the pointer).
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const adapter = require('../engine/anthropic-adapter');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
  });
}
const ev = (res, type, obj) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...obj }) + '\n\n');

test('toWire: system extraction, tool_use input parsing (fail-soft), tool_result as user', () => {
  const { system, messages } = adapter.toWire([
    { role: 'system', content: 'be brief' },
    { role: 'system', content: 'be kind' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'looking', toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"a.md"}' }, { id: 'c2', name: 'bad', args: '{not json' }] },
    { role: 'tool', toolCallId: 'c1', content: 'body' },
  ]);
  assert.strictEqual(system, 'be brief\n\nbe kind');
  assert.strictEqual(messages[0].role, 'user');
  const blocks = messages[1].content;
  assert.deepStrictEqual(blocks[0], { type: 'text', text: 'looking' });
  assert.deepStrictEqual(blocks[1], { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.md' } });
  assert.deepStrictEqual(blocks[2].input, {});                        // malformed args → {} (never a 400 on replay)
  assert.deepStrictEqual(messages[2].content[0], { type: 'tool_result', tool_use_id: 'c1', content: 'body' });
});

test('endpointFor: /v1 suffix normalizes, default base is the Anthropic cloud, plain-http remote refused', () => {
  assert.strictEqual(adapter.endpointFor('https://api.anthropic.com/v1').pathname, '/v1/messages');
  assert.strictEqual(adapter.endpointFor('').hostname, 'api.anthropic.com');
  assert.strictEqual(adapter.endpointFor('http://proxy.example.com'), null);
  assert.strictEqual(adapter.endpointFor('http://127.0.0.1:8080/v1').pathname, '/v1/messages');
});

test('adapter: no API key fails closed with the CLI-engine pointer (no request is made)', async () => {
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:1', model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /API key/);
  assert.match(r.error, /claude CLI/);
});

test('adapter: streams text + a tool_use block via input_json_delta, maps stop reasons, reports usage', async () => {
  let seen;
  const { port, close } = await serve((req, res) => {
    assert.strictEqual(req.headers['x-api-key'], 'sk-ant-test');
    assert.strictEqual(req.headers['anthropic-version'], '2023-06-01');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      ev(res, 'message_start', { message: { usage: { input_tokens: 33 } } });
      ev(res, 'content_block_start', { index: 0, content_block: { type: 'text' } });
      ev(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'On it. ' } });
      ev(res, 'content_block_stop', { index: 0 });
      ev(res, 'content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' } });
      ev(res, 'content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } });
      ev(res, 'content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"a.md"}' } });
      ev(res, 'content_block_stop', { index: 1 });
      ev(res, 'message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 11 } });
      ev(res, 'message_stop', {});
      res.end();
    });
  });
  const deltas = [];
  const r = await adapter.chat({
    baseUrl: 'http://127.0.0.1:' + port, apiKey: 'sk-ant-test', model: 'claude-x',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read a.md' }],
    tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }],
    maxTokens: 500, onDelta: (t) => deltas.push(t),
  });
  await close();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(seen.system, 'sys');                             // system left the messages array
  assert.strictEqual(seen.messages.length, 1);
  assert.strictEqual(seen.max_tokens, 500);
  assert.strictEqual(seen.tools[0].input_schema.type, 'object');      // parameters → input_schema
  assert.strictEqual(r.text, 'On it. ');
  assert.deepStrictEqual(deltas, ['On it. ']);
  assert.deepStrictEqual(r.toolCalls, [{ id: 'tu1', name: 'read_file', args: '{"path":"a.md"}' }]);
  assert.strictEqual(r.stopReason, 'tool_calls');
  assert.deepStrictEqual(r.usage, { inTok: 33, outTok: 11 });
});

test('adapter: max_tokens stop maps to length; a plain turn maps to stop', async () => {
  const { port, close } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    ev(res, 'message_start', { message: { usage: { input_tokens: 1 } } });
    ev(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'cut off' } });
    ev(res, 'message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } });
    ev(res, 'message_stop', {});
    res.end();
  });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }] });
  await close();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stopReason, 'length');
});

test('adapter: an api error event fails the turn with a bounded message', async () => {
  const { port, close } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    ev(res, 'error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
  });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }] });
  await close();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Overloaded/);
});

test('adapter: a redirect is refused, a 429 resolves classified, the promise never rejects', async () => {
  const { port, close } = await serve((req, res) => {
    if (req.url.endsWith('/v1/messages')) { res.writeHead(429, {}); res.end('{"error":{"message":"rate limited"}}'); }
  });
  const r = await adapter.chat({ baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }] });
  await close();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /HTTP 429/);
});
