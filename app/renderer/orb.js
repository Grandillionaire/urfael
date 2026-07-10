'use strict';
// Urfael visualizer with switchable looks: 'sigil' (rings + telemetry), 'rune' (radiant ring),
// 'ember' (forge coil), 'eye' (a face that follows the cursor + reacts to audio).
// Default 'sigil' is the minimalist rune-stone.
// All reuse one audio loop; theme is swapped live via setTheme().

const STATE_COLORS = {
  idle:      { r: 212, g: 168, b: 90  },   // burnished gold
  listening: { r: 240, g: 214, b: 156 },   // bright gold
  thinking:  { r: 255, g: 138, b: 66  },   // ember
  speaking:  { r: 228, g: 186, b: 110 },   // warm gold
};

class UrfaelOrb {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.analyser = null; this.freq = null;
    this.state = 'idle'; this.level = 0; this.spin = 0;
    this.theme = 'sigil';
    this.petOn = false; this.petSig = {};   // the OPT-IN code-drawn Familiar (URFAEL_PET); default off → _draw byte-identical
    this.gaze = { x: 0, y: 0 }; this.gazeS = { x: 0, y: 0 }; // target + smoothed cursor gaze
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const size = Math.min(window.innerHeight * 0.6, 360); // height-based so it fits both compact + HUD widths
    this.canvas.width = size * dpr; this.canvas.height = size * dpr;
    this.canvas.style.width = size + 'px'; this.canvas.style.height = size + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = size;
  }
  attach(analyser) { this.analyser = analyser; this.freq = new Uint8Array(analyser.frequencyBinCount); }
  setState(s) { this.state = s; }
  setTheme(t) { this.theme = t || 'sigil'; }
  setGaze(g) { if (g) this.gaze = g; }
  setPet(on) { this.petOn = !!on; }                       // toggle the Familiar layer (from cfg.pet at boot)
  setPetSignal(sig) { this.petSig = (sig && typeof sig === 'object') ? sig : {}; }   // { tool?, aborted?/failed? } — cheap no-op when pet off

  _sampleLevel() {
    const active = (this.state === 'listening' || this.state === 'speaking');
    let target = 0;
    if (active && this.analyser) {
      this.analyser.getByteFrequencyData(this.freq);
      let sum = 0; for (let i = 0; i < this.freq.length; i++) sum += this.freq[i];
      target = Math.min(1, (sum / this.freq.length) / 110);
    } else {
      const base = this.state === 'thinking' ? 0.28 : 0.16;
      target = base + 0.05 * Math.sin(performance.now() / 600);
    }
    this.level += (target - this.level) * 0.18;
  }
  _col(c, a) { return `rgba(${c.r},${c.g},${c.b},${a})`; }

  start() { const loop = () => { this._draw(); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }

  _draw() {
    this._sampleLevel();
    this.gazeS.x += (this.gaze.x - this.gazeS.x) * 0.15;
    this.gazeS.y += (this.gaze.y - this.gazeS.y) * 0.15;
    this.ctx.clearRect(0, 0, this.size, this.size);
    if (this.theme === 'eye') this._drawFace();
    else if (this.theme === 'ember') this._drawReactor();
    else if (this.theme === 'sigil') this._drawMk2();
    else this._drawArc();
    // ONE early guard → when petOn is false the frame is byte-identical to before; a render glitch degrades to no-pet.
    if (this.petOn) { try { this._drawFamiliar(); } catch {} }
  }

  // ---------- the Familiar: a small code-drawn companion, drawn with the SAME primitives + STATE_COLORS ----------
  // Consumes the pure pet module (window.UrfaelPet): mapState → poseFor, then draws posture/eye/limb/glow. tool /
  // waiting / failed have no colour key, so they tint via the existing STATE_COLORS[x] || STATE_COLORS.idle fallback
  // plus a distinct posture, so no default colour key changes and the orb's voice states render unchanged.
  _drawFamiliar() {
    const P = (typeof window !== 'undefined') && window.UrfaelPet; if (!P) return;
    const st = P.mapState(this.state, this.petSig || {});
    const pose = P.poseFor(st) || {};
    const { ctx, size } = this;
    const c = STATE_COLORS[st] || STATE_COLORS.idle;
    const col = (a) => this._col(c, a);
    const s = size * 0.11;                                      // a small Familiar, tucked below the sigil
    const cx = size * 0.5, cy = size * 0.5 + size * 0.34;
    const lean = (pose.posture - 0.5) * s * 0.9;
    ctx.save(); ctx.translate(cx, cy); ctx.lineCap = 'round'; ctx.shadowColor = col(0.8);
    // aura from glow
    const g = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, s * 1.9);
    g.addColorStop(0, col(0.10 + (pose.glow || 0) * 0.16)); g.addColorStop(1, col(0));
    ctx.fillStyle = g; ctx.fillRect(-s * 2, -s * 2, s * 4, s * 4);
    // body
    ctx.shadowBlur = 6; ctx.lineWidth = 1.4; ctx.strokeStyle = col(0.25 + (pose.glow || 0) * 0.6);
    ctx.beginPath(); ctx.arc(lean * 0.3, 0, s, 0, Math.PI * 2); ctx.stroke();
    // eyes — openness from pose.eye
    const eo = 0.12 + (pose.eye || 0) * 0.5, er = s * 0.16;
    ctx.fillStyle = col(0.95);
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(lean * 0.3 + sx * s * 0.34, -s * 0.1, er, er * eo, 0, 0, Math.PI * 2); ctx.fill(); }
    // limb reaching for the implement — extension from pose.limb, so the Familiar visibly "wields" a live tool
    const reach = (pose.limb || 0) * s * 1.4;
    if (reach > s * 0.3) { ctx.lineWidth = 1.6; ctx.strokeStyle = col(0.8); ctx.beginPath(); ctx.moveTo(lean * 0.3 + s * 0.7, s * 0.1); ctx.lineTo(lean * 0.3 + s * 0.7 + reach, s * 0.1 - reach * 0.2); ctx.stroke(); }
    ctx.restore();
  }

  // ---------- sigil: minimalist rune-stone — one ring, the Uruz rune, breathing light ----------
  _drawMk2() {
    const { ctx, size } = this;
    const c = STATE_COLORS[this.state] || STATE_COLORS.idle;
    const col = (a) => this._col(c, a);
    const cx = size / 2, cy = size / 2, R = size * 0.30, lvl = this.level, t = performance.now() / 1000;
    this.spin += (this.state === 'thinking' ? 1.6 : 0.25 + lvl * 0.8) * 0.016;
    ctx.save(); ctx.translate(cx, cy); ctx.lineCap = 'butt'; ctx.shadowColor = col(0.8);

    // soft backdrop glow (restrained)
    const glow = ctx.createRadialGradient(0, 0, R * 0.3, 0, 0, R * (1.5 + lvl * 0.4));
    glow.addColorStop(0, col(0.10 + lvl * 0.12)); glow.addColorStop(1, col(0));
    ctx.fillStyle = glow; ctx.fillRect(-size / 2, -size / 2, size, size);

    // the ring
    ctx.shadowBlur = 6; ctx.lineWidth = 1.5; ctx.strokeStyle = col(0.8);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();

    // voice: a sparse tick ring just inside the rim
    const ticks = 48, rI = R * 0.88;
    for (let i = 0; i < ticks; i++) {
      let amp;
      if (this.freq && (this.state === 'listening' || this.state === 'speaking')) amp = this.freq[Math.floor((i / ticks) * (this.freq.length * 0.7))] / 255;
      else amp = 0.05 + 0.04 * Math.abs(Math.sin(i * 0.7 + t * 1.2));
      const a = (i / ticks) * Math.PI * 2 - Math.PI / 2;
      const len = R * 0.05 + amp * R * 0.16;
      ctx.strokeStyle = col(0.15 + amp * 0.5); ctx.lineWidth = 1.5; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * rI, Math.sin(a) * rI); ctx.lineTo(Math.cos(a) * (rI - len), Math.sin(a) * (rI - len)); ctx.stroke();
    }

    // thinking: one slow arc tracing the rim
    if (this.state === 'thinking') {
      ctx.shadowBlur = 10; ctx.lineWidth = 2.5; ctx.strokeStyle = col(0.95);
      const a = this.spin * 2.0;
      ctx.beginPath(); ctx.arc(0, 0, R, a, a + 0.9); ctx.stroke();
    }

    // the Uruz rune (ᚢ — public-domain Elder Futhark), breathing with the voice
    const w = R * 0.52, x0 = -w * 0.5, x1 = w * 0.5;
    const yTop = -w * 0.62, yBot = w * 0.66, yMid = -w * 0.20;
    ctx.lineWidth = Math.max(3, R * 0.085); ctx.shadowBlur = 12 + lvl * 18;
    ctx.strokeStyle = col(0.75 + lvl * 0.25);
    ctx.beginPath();
    ctx.moveTo(x0, yBot); ctx.lineTo(x0, yTop);
    ctx.lineTo(x1, yMid);
    ctx.lineTo(x1, yBot);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- classic arc-reactor ----------
  _drawArc() {
    const { ctx, size } = this;
    const c = STATE_COLORS[this.state] || STATE_COLORS.idle;
    const col = (a) => this._col(c, a);
    const cx = size / 2, cy = size / 2, R = size * 0.30, lvl = this.level, t = performance.now() / 1000;
    this.spin += (this.state === 'thinking' ? 2.6 : 0.5 + lvl * 1.5) * 0.016;
    ctx.save(); ctx.translate(cx, cy);
    const glow = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * (1.7 + lvl));
    glow.addColorStop(0, col(0.18 + lvl * 0.25)); glow.addColorStop(1, col(0));
    ctx.fillStyle = glow; ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.lineCap = 'round'; ctx.shadowColor = col(0.9);
    const bars = 72, r0 = R * 1.06;
    ctx.shadowBlur = 8;
    for (let i = 0; i < bars; i++) {
      let amp; if (this.freq && (this.state === 'listening' || this.state === 'speaking')) { amp = this.freq[Math.floor((i / bars) * (this.freq.length * 0.7))] / 255; } else { amp = 0.08 + 0.06 * Math.abs(Math.sin(i * 0.6 + t * 2)); }
      const len = R * (0.06 + amp * 0.55), a = (i / bars) * Math.PI * 2 + this.spin * 0.3;
      ctx.strokeStyle = col(0.35 + amp * 0.6); ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len)); ctx.stroke();
    }
    const ring = (radius, w, alpha, blur) => { ctx.shadowBlur = blur; ctx.strokeStyle = col(alpha); ctx.lineWidth = w; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke(); };
    ring(R, 2.5, 0.85, 14); ring(R * 0.82, 1.2, 0.4, 6);
    const ticks = (radius, count, dir, lenFrac, alpha) => { ctx.lineWidth = 3; ctx.shadowBlur = 10; ctx.strokeStyle = col(alpha); for (let i = 0; i < count; i++) { const a = (i / count) * Math.PI * 2 + this.spin * dir, l = radius * lenFrac; ctx.beginPath(); ctx.moveTo(Math.cos(a) * radius, Math.sin(a) * radius); ctx.lineTo(Math.cos(a) * (radius + l), Math.sin(a) * (radius + l)); ctx.stroke(); } };
    ticks(R, 3, 1, 0.10, 0.9); ticks(R * 0.62, 24, -1.4, 0.06, 0.5);
    const coreR = R * (0.42 + lvl * 0.22), core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, col(0.95)); core.addColorStop(0.6, col(0.5 + lvl * 0.3)); core.addColorStop(1, col(0));
    ctx.shadowBlur = 30; ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, coreR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------- triangular Mark-style reactor ----------
  _drawReactor() {
    const { ctx, size } = this;
    const c = STATE_COLORS[this.state] || STATE_COLORS.idle;
    const col = (a) => this._col(c, a);
    const cx = size / 2, cy = size / 2, R = size * 0.30, lvl = this.level;
    this.spin += (this.state === 'thinking' ? 2.2 : 0.4 + lvl * 1.2) * 0.016;
    ctx.save(); ctx.translate(cx, cy); ctx.lineCap = 'round'; ctx.shadowColor = col(0.9);
    const glow = ctx.createRadialGradient(0, 0, R * 0.15, 0, 0, R * 1.7);
    glow.addColorStop(0, col(0.2 + lvl * 0.25)); glow.addColorStop(1, col(0));
    ctx.fillStyle = glow; ctx.fillRect(-size / 2, -size / 2, size, size);
    // segmented outer coil ring (6 arcs with gaps)
    ctx.shadowBlur = 12; ctx.lineWidth = 6; ctx.strokeStyle = col(0.7);
    for (let i = 0; i < 6; i++) { const a0 = (i / 6) * Math.PI * 2 + this.spin * 0.5; ctx.beginPath(); ctx.arc(0, 0, R, a0 + 0.18, a0 + Math.PI / 3 - 0.18); ctx.stroke(); }
    // radial spokes (copper coils) counter-rotating
    ctx.lineWidth = 3; ctx.strokeStyle = col(0.45);
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 - this.spin; ctx.beginPath(); ctx.moveTo(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5); ctx.lineTo(Math.cos(a) * R * 0.92, Math.sin(a) * R * 0.92); ctx.stroke(); }
    // glowing central triangle, slow rotation, pulsing with level
    ctx.rotate(this.spin * 0.3);
    const tr = R * (0.40 + lvl * 0.12);
    ctx.shadowBlur = 28; ctx.lineWidth = 4; ctx.strokeStyle = col(0.95);
    ctx.beginPath(); for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 - Math.PI / 2, x = Math.cos(a) * tr, y = Math.sin(a) * tr; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); ctx.stroke();
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, tr);
    core.addColorStop(0, col(0.9)); core.addColorStop(0.7, col(0.35 + lvl * 0.3)); core.addColorStop(1, col(0));
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, tr * 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------- cursor-following smiley ----------
  _drawFace() {
    const { ctx, size } = this;
    const c = STATE_COLORS[this.state] || STATE_COLORS.idle;
    const col = (a) => this._col(c, a);
    const cx = size / 2, cy = size / 2, R = size * 0.34, lvl = this.level, now = performance.now();
    ctx.save(); ctx.translate(cx, cy); ctx.lineCap = 'round'; ctx.shadowColor = col(0.9);
    // soft face glow + outline
    const glow = ctx.createRadialGradient(0, 0, R * 0.4, 0, 0, R * 1.5);
    glow.addColorStop(0, col(0.15 + lvl * 0.2)); glow.addColorStop(1, col(0));
    ctx.fillStyle = glow; ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.shadowBlur = 16; ctx.lineWidth = 3; ctx.strokeStyle = col(0.7);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    // eyes — pupils follow the cursor; blink ~ every 4s
    const ex = R * 0.42, ey = -R * 0.22, eR = R * 0.16;
    const blink = (now % 4000 < 140) ? 0.12 : 1;            // squash height briefly to blink
    const gx = this.gazeS.x * eR * 0.5, gy = this.gazeS.y * eR * 0.5;
    ctx.shadowBlur = 14;
    for (const sx of [-1, 1]) {
      ctx.fillStyle = col(0.18); ctx.beginPath(); ctx.ellipse(sx * ex, ey, eR, eR * blink, 0, 0, Math.PI * 2); ctx.fill();        // eye well
      ctx.fillStyle = col(0.98); ctx.beginPath(); ctx.ellipse(sx * ex + gx, ey + gy, eR * 0.5, eR * 0.5 * blink, 0, 0, Math.PI * 2); ctx.fill(); // pupil tracks cursor
    }
    // mouth — a smile that opens/animates with the voice
    ctx.shadowBlur = 16; ctx.strokeStyle = col(0.95); ctx.lineWidth = 4;
    const my = R * 0.28, mw = R * 0.5;
    const open = (this.state === 'speaking' || this.state === 'listening') ? lvl : 0;
    if (open > 0.18) {                                       // talking: open mouth (smiling 'O')
      ctx.beginPath(); ctx.ellipse(0, my, mw * 0.6, R * (0.10 + open * 0.22), 0, 0, Math.PI * 2); ctx.stroke();
    } else {                                                 // resting / idle: a warm smile
      ctx.beginPath(); ctx.arc(0, my - R * 0.14, mw, 0.18 * Math.PI, 0.82 * Math.PI); ctx.stroke();
    }
    ctx.restore();
  }
}

window.UrfaelOrb = UrfaelOrb;
