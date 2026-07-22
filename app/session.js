'use strict';
// Warm-session turn machinery, extracted from daemon.js as a PURE MOVE so the queue / timeout / fallback / exit
// paths are unit-testable in isolation (app/test/session.test.js). createSessionModule(deps) takes every
// collaborator as an INJECTED dependency — the real spawn, the emit surface (sendThinking/sendSay), logEvent, the
// pure lib helpers, and the live daemon config + state getters — and returns { Session, getSession,
// getSessionByKey, sessions }. daemon.js requires this and wires the real deps; nothing here reaches back into
// daemon.js (no circular require).
//
// Behaviour is byte-for-byte the daemon's original turn loop: the ONLY edits versus the in-daemon code are that the
// two pieces of LIVE daemon state the spawn reads — the active persona overlay and a provider secret — arrive
// through injected getters (getOverlay / secretFor) instead of closing over the module globals, because both are
// reassigned in daemon.js and so must be read at spawn time, never snapshotted at wiring time.
module.exports = function createSessionModule(deps) {
  const {
    spawn, logEvent, sendThinking, sendSay, deDash, classifyError, segmentSentences,
    providerSessions, providerList, secretFor, recordBrainPid, getOverlay, pluginMcpArgs,
    CLAUDE_BIN, CLAUDE_PRE = [], VAULT, MEMDIR_ADD, PERM_MODE, MAX_SPOKEN_CHARS, TURN_TIMEOUT_MS,
  } = deps;

  // One warm Claude process per model (stdin kept open). stderr is drained into a small ring buffer so a failed
  // turn can be classified (why it failed), without ever stalling the child.
  class Session {
    constructor(model) { this.model = model; this.proc = null; this.queue = []; this.current = null; this.buf = ''; this.acc = ''; this.errBuf = ''; this.lastFailed = false; this.spokenSent = false; this.spokenDone = false; this.spokenEmitted = 0; this.spokenChars = 0; this.speakCur = false; this.curSilent = false; this.curTurn = 0; this.spawnErr = null; }
    _ensure() {
      if (this.proc && !this.proc.killed) return;
      const currentOverlay = getOverlay();   // live active PERSONA voice, read at spawn time (never snapshotted)
      const overlayArgs = currentOverlay ? ['--append-system-prompt', currentOverlay] : [];   // active PERSONA voice; [] on the anchor → byte-identical spawn
      // Per-chat provider routing is resolved into the CHILD env ONLY. When providerId is '' (the anchor) childEnv is
      // the unchanged {...process.env}, so the warm spawn stays byte-identical. resolveScopedEnv returns a NEW object,
      // so process.env is never mutated and the provider secret stays scoped to this child (never logged, never global).
      let childEnv = { ...process.env, URFAEL_OVERLAY: '1' };
      this.spawnErr = null;
      if (this.providerId) {
        const e = providerSessions.findProvider(providerList(), this.providerId);
        if (e) {
          // FAIL-CLOSED: a key-auth provider missing its stored secret must NEVER fall back to the daemon's own
          // (base-env) credentials — that would silently answer this chat on the MAIN provider. Refuse to spawn and
          // surface the failure to the waiter (drained in _next); never spawn a provider-bound child on the base env.
          try { childEnv = providerSessions.resolveScopedEnv(childEnv, e, secretFor(e.authEnv)); }
          catch (err) { logEvent({ ev: 'chat_provider_no_secret', provider: this.providerId }); this.spawnErr = 'provider ' + this.providerId + ' needs its key, set it with: urfael plugin secret ' + (e.authEnv || ''); return; }
          childEnv.URFAEL_OVERLAY = '1';
        }
      }
      this.proc = spawn(CLAUDE_BIN, CLAUDE_PRE.concat([
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--model', this.model, '--verbose', '--include-partial-messages', '--permission-mode', PERM_MODE,
        ...MEMDIR_ADD,   // the brain can READ its own memory (it lives outside the vault/project root)
        ...overlayArgs,  // persona = a VOICE overlay only; the moat is PERM_MODE + the vault settings, not this text
        ...pluginMcpArgs(),  // enabled plugins on the WARM (owner) session only; [] when none → byte-identical spawn. Scoped/remote/cron spawns stay --strict-mcp-config, so a plugin never reaches an untrusted turn.
      ]), { cwd: VAULT, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      const p = this.proc; // bind handlers to THIS proc identity so a stale exit can't clobber a freshly-spawned one
      recordBrainPid(p.pid);
      p.stdout.on('data', (d) => this._onData(d));
      if (p.stderr) p.stderr.on('data', (d) => { try { this.errBuf = (this.errBuf + d).slice(-2048); } catch {} });   // drained (consumed) so it can't stall; last 2KB kept for classification
      p.on('exit', () => { logEvent({ ev: 'brain_exit', model: this.model, cat: classifyError(this.errBuf).category }); if (this.proc !== p) return; this.proc = null;
        // mirror the timeout/abort cleanup: clear THIS turn's watchdog (else it later aborts a healthy turn) and drain
        // the queue so a turn waiting behind the crashed one is promoted instead of hanging forever.
        if (this.current) { const c = this.current; this.current = null; this.lastFailed = true; clearTimeout(c.timer); c.cb('(' + (classifyError(this.errBuf).hint || 'restarted, try again') + ')'); }
        this._next(); });
      p.on('error', (e) => { // spawn failure (claude missing / bad cwd) must never crash the daemon
        logEvent({ ev: 'brain_spawn_error', model: this.model, err: String((e && e.message) || e), cat: classifyError(this.errBuf || String((e && e.message) || e)).category });
        if (this.proc !== p) return;
        this.proc = null;
        if (this.current) { const c = this.current; this.current = null; this.lastFailed = true; clearTimeout(c.timer); c.cb('(' + (classifyError(this.errBuf || String((e && e.message) || e)).hint || 'brain spawn failed, is claude installed?') + ')'); }
        this._next();   // promote a turn queued behind the spawn failure instead of hanging it forever
      });
    }
    _onData(d) {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        this._handle(e);
      }
    }
    _handle(e) {
      if (!this.current) return;
      if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
        const t = e.event.delta.text;
        if (!this.curSilent) sendThinking({ delta: deDash(t) }); // HUD shows the full streaming answer, de-dashed (tags stripped client-side)
        if (this.speakCur) { this.acc += t; this._emitSpoken(false); } // voice = ONLY the [SPOKEN] comment, streamed by sentence
      }
      if (e.type === 'assistant' && !this.curSilent) { for (const b of (e.message?.content || [])) if (b.type === 'tool_use') sendThinking({ tool: b.name }); }
      if (e.type === 'result') {
        this.lastUsage = e.usage || (e.modelUsage ? Object.values(e.modelUsage)[0] : null) || null; // tokens for telemetry (session is serialized, so this is race-free)
        if (this.speakCur && !this.spokenDone) {
          if (/\[SPOKEN\]/i.test(this.acc)) this._emitSpoken(true); // open tag, never closed → flush what's pending (capped)
          if (!this.spokenSent) {                   // fallback: no [SPOKEN] tags → speak one short line so it isn't silent
            const m = this.acc.match(/[^.!?]*[.!?]/);
            const c = (m ? m[0] : this.acc.slice(0, 160)).replace(/\[\/?SPOKEN\]/gi, '').trim();
            if (c) { this.spokenSent = true; sendSay({ text: c, turnId: this.curTurn }); }
          }
          if (!this.spokenDone) { this.spokenDone = true; sendSay({ end: true, turnId: this.curTurn }); }
        }
        const c = this.current; this.current = null; clearTimeout(c.timer);
        c.cb(typeof e.result === 'string' ? deDash(e.result) : '');
        this._next();
      }
    }
    // Stream the [SPOKEN]...[/SPOKEN] comment sentence-by-sentence as it arrives, so the voice starts
    // the moment the first sentence completes instead of waiting for the closing tag. Capped at
    // MAX_SPOKEN_CHARS so a runaway/unclosed block can't read the whole answer aloud.
    _emitSpoken(flush) {
      if (this.spokenDone) return;
      const open = this.acc.search(/\[SPOKEN\]/i);
      if (open < 0) return;
      const start = open + '[SPOKEN]'.length;
      const closeRel = this.acc.slice(start).search(/\[\/SPOKEN\]/i);
      const closed = closeRel >= 0;
      const content = closed ? this.acc.slice(start, start + closeRel) : this.acc.slice(start);
      const { sentences, rest } = segmentSentences(content.slice(this.spokenEmitted), closed || flush);
      for (const s of sentences) {
        if (this.spokenChars >= MAX_SPOKEN_CHARS) break;
        this.spokenChars += s.length; this.spokenSent = true;
        sendSay({ text: s, turnId: this.curTurn });
      }
      this.spokenEmitted = content.length - rest.length;
      if (closed || this.spokenChars >= MAX_SPOKEN_CHARS) { this.spokenDone = true; sendSay({ end: true, turnId: this.curTurn }); }
    }
    _send(text) { this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'); }
    _next() {
      if (this.current || !this.queue.length) return;
      this._ensure();
      if (this.spawnErr) {   // fail-closed: provider env unresolved (missing key) — fail this turn, never spawn on the base env
        const c = this.queue.shift(); const reason = this.spawnErr; this.spawnErr = null; this.lastFailed = true;
        c.cb('(' + reason + ')'); this._next(); return;
      }
      this.current = this.queue.shift();
      this.speakCur = !!this.current.speak; this.curSilent = !!this.current.silent; this.curTurn = this.current.turnId || 0;
      this.acc = ''; this.errBuf = ''; this.lastFailed = false; this.spokenSent = false; this.spokenDone = false; this.spokenEmitted = 0; this.spokenChars = 0;
      this.current.timer = setTimeout(() => {
        if (!this.current) return;
        const c = this.current; this.current = null; this.lastFailed = true;
        this.errBuf = 'timed out';   // record a RETRYABLE reason so the fallback gate (classifyError -> timeout/retryable) fires; re-zeroed in _next on the next turn
        try { this.proc && this.proc.kill('SIGKILL'); } catch {} this.proc = null; // discard hung process
        c.cb('(timed out)'); this._next();
      }, TURN_TIMEOUT_MS);
      this._send(this.current.text);
    }
    ask(text, opts = {}) { return new Promise((res) => { this.queue.push({ text, cb: res, speak: opts.speak, silent: opts.silent, turnId: opts.turnId }); this._next(); }); }
    // Abort the in-flight turn (if any): mirror the timeout path — clear the watchdog, SIGKILL the proc,
    // discard it, resolve the waiter with '(stopped)', then drain the queue. No-op when idle.
    abort() {
      if (!this.current) return false;
      if (this.speakCur && !this.spokenDone) { this.spokenDone = true; sendSay({ end: true, turnId: this.curTurn }); } // cleanly end the dangling spoken stream
      const c = this.current; this.current = null; clearTimeout(c.timer);
      try { this.proc && this.proc.kill('SIGKILL'); } catch {} this.proc = null; // discard the killed process
      c.cb('(stopped)'); this._next();
      return true;
    }
  }

  const sessions = new Map();
  function getSession(model, providerId) {
    const key = providerSessions.sessionKey(model, providerId);
    if (!sessions.has(key)) { const s = new Session(model); s.providerId = providerId || ''; sessions.set(key, s); }
    return sessions.get(key);
  }
  // getSessionByKey: a warm session under an EXPLICIT bucket key (used for per-chat tiles, whose key folds in the
  // chatId so each tile is its own child and never the shared main-brain bucket). The model+providerId still drive
  // the spawn + scoped child env exactly as getSession does; only the Map key differs.
  function getSessionByKey(key, model, providerId) {
    if (!sessions.has(key)) { const s = new Session(model); s.providerId = providerId || ''; sessions.set(key, s); }
    return sessions.get(key);
  }

  return { Session, getSession, getSessionByKey, sessions };
};
