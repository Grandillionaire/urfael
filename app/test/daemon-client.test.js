'use strict';
// Direct unit tests for the shared daemon socket client (app/daemon-client.js). A tiny http.Server on a throwaway
// unix socket plays the daemon: it replays golden NDJSON fixtures (delta / tool / say / done, plus a data-plane
// {kind:'error'} line), and stages a mid-stream socket error and a timeout, so streamAsk's framing + routing +
// terminal-phase contract is pinned WITHOUT a real login. request()'s round-trip + reject semantics are covered too.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dc = require('../daemon-client');

let DIR, SOCK, server, MIDSOCK, midServer;

// Golden /ask stream: the exact event shapes the daemon emits (thinking delta, thinking tool, thinking reset,
// say text, say end, done with usage). Written as NDJSON, deliberately including a blank line and one unparsable
// line so the framing guards (skip blank, skip bad JSON) are exercised.
const GOLDEN = [
  JSON.stringify({ kind: 'thinking', reset: true, model: 'sonnet', turnId: 1 }),
  JSON.stringify({ kind: 'thinking', tool: 'Read' }),
  JSON.stringify({ kind: 'thinking', delta: 'Hello' }),
  '',                                                      // blank line: must be skipped
  '{ this is not json',                                   // unparsable: must be skipped
  JSON.stringify({ kind: 'thinking', delta: ', world' }),
  JSON.stringify({ kind: 'say', text: 'spoken bit', turnId: 1 }),
  JSON.stringify({ kind: 'say', end: true, turnId: 1 }),
  JSON.stringify({ kind: 'done', text: 'Hello, world', model: 'sonnet', ms: 1200, usage: { output_tokens: 3 } }),
].join('\n') + '\n';

function handler(req, res) {
  const u = req.url;
  if (u === '/echo') {                                    // request(): echo the method + body back as JSON
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ method: req.method, body: b })); });
    return;
  }
  if (u === '/plain') { res.writeHead(200); res.end('not json at all'); return; }   // request(): raw non-JSON body
  if (u === '/hang') { /* never respond -> force a client timeout */ return; }
  if (u === '/ask') {                                     // stream the golden fixture, split across two chunks
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const mid = Math.floor(GOLDEN.length / 2);
    res.write(GOLDEN.slice(0, mid));
    setTimeout(() => { res.write(GOLDEN.slice(mid)); res.end(); }, 15);   // second chunk splits a line boundary
    return;
  }
  if (u === '/ask-error-line') {                          // a data-plane {kind:'error'} NDJSON line
    res.writeHead(200); res.write(JSON.stringify({ kind: 'error', reason: 'boom' }) + '\n'); res.end();
    return;
  }
  res.writeHead(404); res.end();
}

// A raw HTTP peer that delivers one good chunked NDJSON delta then a MALFORMED chunk, so the client's HTTP parser
// raises a real mid-stream request 'error' (a unix-socket peer that merely destroys the socket only fires the
// 'aborted' event, which the surfaces intentionally ignore, so it would not exercise the onError('error') path).
function midHandler(c) {
  const line = JSON.stringify({ kind: 'thinking', delta: 'partial' }) + '\n';
  c.once('data', () => {
    c.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
    c.write(Buffer.byteLength(line).toString(16) + '\r\n' + line + '\r\n');
    setTimeout(() => { try { c.write('zz\r\n'); c.end(); } catch {} }, 20);   // 'zz' is not a hex chunk size -> parse error
  });
}

describe('daemon-client (golden NDJSON fixtures over a real unix socket)', () => {
  before(async () => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-dc-'));
    // win32 cannot bind a filesystem path — use unique named pipes there; the client treats both identically
    const pipe = (n) => process.platform === 'win32' ? '\\\\.\\pipe\\urf-dc-' + path.basename(DIR) + '-' + n : path.join(DIR, n + '.sock');
    SOCK = pipe('s');
    server = http.createServer(handler);
    await new Promise((r) => server.listen(SOCK, r));
    MIDSOCK = pipe('mid');
    midServer = net.createServer(midHandler);
    await new Promise((r) => midServer.listen(MIDSOCK, r));
  });
  after(async () => {
    try { await new Promise((r) => server.close(r)); } catch {}
    try { await new Promise((r) => midServer.close(r)); } catch {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  });

  it('streamAsk frames + routes every event kind and ends with phase "end"', async () => {
    const got = { delta: [], tool: [], say: [], thinking: [], done: [], errPhases: [] };
    await new Promise((resolve) => {
      dc.streamAsk('hi', {
        onDelta: (e) => got.delta.push(e.delta),
        onTool: (e) => got.tool.push(e.tool),
        onSay: (e) => got.say.push(e),
        onThinking: (e) => got.thinking.push(e),
        onDone: (e) => got.done.push(e),
        onError: (err) => { got.errPhases.push(err.phase); if (err.phase === 'end') resolve(); },
      }, { socketPath: SOCK });
    });
    assert.deepEqual(got.delta, ['Hello', ', world'], 'both deltas, in order, blank + bad-JSON lines skipped');
    assert.deepEqual(got.tool, ['Read'], 'the tool event routed to onTool');
    assert.equal(got.say.length, 2, 'both say events routed to onSay (text then end)');
    assert.equal(got.say[0].text, 'spoken bit');
    assert.equal(got.say[1].end, true);
    assert.equal(got.thinking.length, 1, 'the reset event (no tool, no delta) routed to onThinking');
    assert.equal(got.thinking[0].reset, true);
    assert.equal(got.done.length, 1, 'exactly one done event');
    assert.equal(got.done[0].text, 'Hello, world');
    assert.equal(got.done[0].usage.output_tokens, 3, 'usage survives to the done event');
    assert.deepEqual(got.errPhases, ['end'], 'a clean stream terminates with a single onError(phase:end)');
  });

  it('streamAsk routes tool + delta to onThinking when no split callbacks are given (the overlay-forward shape)', async () => {
    const raw = [];
    await new Promise((resolve) => {
      dc.streamAsk('hi', {
        onThinking: (e) => raw.push(e),
        onDone: () => {},
        onError: (err) => { if (err.phase === 'end') resolve(); },
      }, { socketPath: SOCK });
    });
    // with neither onTool nor onDelta, the reset + tool + both deltas all fall through to onThinking (raw forward)
    assert.deepEqual(raw.map((e) => e.tool || e.delta || (e.reset ? 'reset' : '?')), ['reset', 'Read', 'Hello', ', world']);
  });

  it('streamAsk maps a data-plane {kind:"error"} line to onError(phase:"stream") with the event', async () => {
    const seen = [];
    await new Promise((resolve) => {
      dc.streamAsk('hi', { onError: (err) => { seen.push(err); if (err.phase === 'end') resolve(); } }, { socketPath: SOCK, path: '/ask-error-line' });
    });
    assert.equal(seen[0].phase, 'stream');
    assert.equal(seen[0].reason, 'boom', 'the error event object is passed through');
    assert.equal(seen[1].phase, 'end', 'the stream still ends after the error line');
  });

  it('streamAsk surfaces a mid-stream socket error as onError(phase:"error") after the partial delta', async () => {
    const deltas = []; let phase = null;
    await new Promise((resolve) => {
      dc.streamAsk('hi', {
        onDelta: (e) => deltas.push(e.delta),
        onError: (err) => { phase = err.phase; resolve(); },
      }, { socketPath: MIDSOCK, path: '/ask' });
    });
    assert.deepEqual(deltas, ['partial'], 'the delta emitted before the drop is delivered');
    assert.equal(phase, 'error', 'a mid-stream socket drop is phase "error"');
  });

  it('streamAsk enforces a timeout as onError(phase:"timeout")', async () => {
    let phase = null;
    await new Promise((resolve) => {
      dc.streamAsk('hi', { onError: (err) => { phase = err.phase; resolve(); } }, { socketPath: SOCK, path: '/hang', timeoutMs: 120 });
    });
    assert.equal(phase, 'timeout');
  });

  it('request resolves the raw body string and passes the method + body through', async () => {
    const raw = await dc.request('POST', '/echo', { hello: 1 }, { socketPath: SOCK });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.method, 'POST');
    assert.deepEqual(JSON.parse(parsed.body), { hello: 1 }, 'the JSON body is serialized + delivered');
  });

  it('request resolves a non-JSON body as a raw string (callers own the parse-or-fallback)', async () => {
    const raw = await dc.request('GET', '/plain', undefined, { socketPath: SOCK });
    assert.equal(raw, 'not json at all');
  });

  it('request rejects new Error("timeout") on a slow peer', async () => {
    await assert.rejects(() => dc.request('GET', '/hang', undefined, { socketPath: SOCK, timeoutMs: 120 }), /timeout/);
  });

  it('request rejects when the socket cannot be reached', async () => {
    await assert.rejects(() => dc.request('GET', '/health', undefined, { socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\urf-dc-nope-' + path.basename(DIR) : path.join(DIR, 'nope.sock'), timeoutMs: 500 }));
  });
});
