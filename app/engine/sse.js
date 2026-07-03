'use strict';
// app/engine/sse.js — incremental Server-Sent-Events parser for the native engine's streaming adapters.
//
// Pure and zero-dep: no I/O, no timers, no state beyond the current partial line. Both the OpenAI-compatible
// and Anthropic adapters stream SSE; this is the one shared parser so framing bugs are fixed (and tested) in
// exactly one place. It is deliberately DUMB about payloads — it emits raw `data:` strings and lets the adapter
// own JSON.parse, because a malformed event must fail THAT adapter's turn, never wedge the byte stream.
//
// Contract (the parts that are load-bearing for the adapters):
//   - feed(chunk) accepts Buffers or strings, in any split — an event broken across TCP chunks reassembles.
//   - Multi-line `data:` fields within one event are joined with '\n' per the SSE spec.
//   - `event:` name is carried alongside (Anthropic routes on it; OpenAI-compatible ignores it).
//   - A bare '[DONE]' data payload is surfaced like any other — the ADAPTER decides it is terminal.
//   - CRLF and LF framing both work (some local model servers emit CRLF).
//   - Output is bounded by the caller: the parser never buffers more than one partial line + one open event.
function createSseParser(onEvent) {
  let lineBuf = '';        // the current PARTIAL line (no terminator seen yet)
  let dataLines = [];      // accumulated data: lines of the OPEN event
  let eventName = '';      // event: field of the open event ('' = default)

  function dispatch() {
    if (dataLines.length === 0) { eventName = ''; return; }   // comment-only / empty event: nothing to emit
    const data = dataLines.join('\n');
    const ev = eventName;
    dataLines = []; eventName = '';
    onEvent(data, ev);
  }

  function takeLine(line) {
    if (line === '') { dispatch(); return; }                  // blank line = event boundary
    if (line[0] === ':') return;                              // SSE comment (keep-alive pings) — ignore
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);             // spec: strip ONE leading space
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    // id:/retry: are irrelevant to both adapters — parsed and dropped.
  }

  return {
    feed(chunk) {
      lineBuf += chunk.toString('utf8');
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        let line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);    // CRLF framing
        takeLine(line);
      }
    },
    // end() — flush a final event that was not blank-line-terminated (some servers close the socket right
    // after the last data line). Safe to call more than once.
    end() {
      if (lineBuf !== '') { let line = lineBuf; lineBuf = ''; if (line.endsWith('\r')) line = line.slice(0, -1); takeLine(line); }
      dispatch();
    },
  };
}

module.exports = { createSseParser };
