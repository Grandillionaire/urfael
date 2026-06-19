'use strict';
// app/acp-translate.js — the PURE translation core of the ACP bridge. It maps the Agent Client Protocol
// (JSON-RPC 2.0 that editors like Zed speak over a subprocess's stdio) to/from Urfael's daemon NDJSON contract.
// No I/O, no sockets, no stdio, no side effects — so the whole protocol surface is unit-testable WITHOUT an editor
// or a running daemon (the thin runtime in acp.js does the actual I/O). The [SPOKEN]-aside strip is delegated to the
// already-battle-tested helpers in openai-api.js so a voice aside can never half-leak into an editor's buffer.
const { stripSpoken, safeRawPrefix, flattenContent } = require('./openai-api');

const PROTOCOL_VERSION = 1;

// ── JSON-RPC 2.0 framers + a fail-soft line parser ──────────────────────────────────────────────────
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message: String(message || '') } }; }
function rpcNotify(method, params) { return { jsonrpc: '2.0', method, params }; }
function parseFramedLine(line) { try { const j = JSON.parse(String(line)); return (j && typeof j === 'object') ? j : null; } catch { return null; } }

// ── initialize: advertise a deliberately minimal, text-only agent (no client fs/terminal callbacks, no per-session
//    MCP — editor-supplied MCP servers are NOT forwarded into the trusted local turn, preserving the moat). ──
function handleInitialize() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcp: false },
    agentInfo: { name: 'urfael' },
    authMethods: [],                 // auth is the OS 0600 mode on the daemon socket; there is no app-level credential
  };
}

// flatten an ACP prompt (an array of content blocks) to the single string the daemon /ask expects. Non-text dropped.
function flattenPromptBlocks(blocks) { return flattenContent(blocks); }

// map a finished turn to an ACP StopReason. An aborted turn (or the daemon's '(stopped)' sentinel) → cancelled;
// a brain error → refusal; otherwise a normal end_turn.
function mapStopReason(d) {
  const t = String((d && d.text) || '');
  if ((d && d.aborted) || t === '(stopped)') return 'cancelled';
  if (/^\(brain (unreachable|error|spawn)/.test(t) || t === '(timed out)') return 'refusal';
  return 'end_turn';
}

// the session/update payloads we emit (ACP agent→client streaming channel).
const agentMessageChunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const toolCall = (toolCallId, title) => ({ sessionUpdate: 'tool_call', toolCallId, title, kind: 'other', status: 'in_progress' });
const toolCallDone = (toolCallId) => ({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });

// fresh per-prompt streaming state (mutated by ndjsonLineToUpdate as daemon NDJSON lines arrive).
function newPromptCtx() { return { acc: '', emitted: 0, toolSeq: 0 }; }

// Map ONE parsed daemon NDJSON line to { updates:[...session/update], done? }. The [SPOKEN] strip is incremental:
// we only ever reveal the prefix that is SAFE (no open aside, no half-formed tag), so an aside can't leak mid-stream.
function ndjsonLineToUpdate(e, ctx) {
  const updates = [];
  if (!e || typeof e !== 'object') return { updates };
  if (e.kind === 'thinking' && typeof e.delta === 'string') {
    ctx.acc += e.delta;
    const safe = stripSpoken(safeRawPrefix(ctx.acc));
    if (safe.length > ctx.emitted) { const chunk = safe.slice(ctx.emitted); ctx.emitted = safe.length; if (chunk) updates.push(agentMessageChunk(chunk)); }
    return { updates };
  }
  if (e.kind === 'thinking' && typeof e.tool === 'string' && e.tool) {
    const id = 'tool-' + (++ctx.toolSeq);                            // the socket exposes the tool NAME only (no args/results)
    updates.push(toolCall(id, e.tool));
    updates.push(toolCallDone(id));
    return { updates };
  }
  if (e.kind === 'done') {
    const full = stripSpoken(typeof e.text === 'string' && e.text ? e.text : ctx.acc);   // authoritative answer; flush whatever was held back
    if (full.length > ctx.emitted) { const chunk = full.slice(ctx.emitted); ctx.emitted = full.length; if (chunk) updates.push(agentMessageChunk(chunk)); }
    return { updates, done: { stopReason: mapStopReason({ text: full, aborted: e.aborted }), model: e.model || '', usage: e.usage || null } };
  }
  return { updates };                                                // {kind:'say'} (voice aside) and unknown kinds → dropped
}

module.exports = {
  PROTOCOL_VERSION, rpcResult, rpcError, rpcNotify, parseFramedLine,
  handleInitialize, flattenPromptBlocks, mapStopReason, newPromptCtx, ndjsonLineToUpdate,
};
