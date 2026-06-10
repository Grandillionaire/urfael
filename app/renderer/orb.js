'use strict';
// Urfael visualizer with switchable looks: 'sigil' (rings + telemetry), 'rune' (radiant ring),
// 'ember' (forge coil), 'eye' (a face that follows the cursor + reacts to audio).
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
  }

  // ---------- Mk II: arc-reactor core fused with a telemetry ring + radar sweep ----------
  _drawMk2() {
    const { ctx, size } = this;
    const c = STATE_COLORS[this.state] || STATE_COLORS.idle;
    const col = (a) => this._col(c, a);
    const cx = size / 2, cy = size / 2, R = size * 0.26, lvl = this.level, t = performance.now() / 1000;
    this.spin += (this.state === 'thinking' ? 2.2 : 0.45 + lvl * 1.3) * 0.016;
    ctx.save(); ctx.translate(cx, cy); ctx.lineCap = 'round'; ctx.shadowColor = col(0.9);

    const glow = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * (1.9 + lvl));
    glow.addColorStop(0, col(0.16 + lvl * 0.22)); glow.addColorStop(1, col(0));
    ctx.fillStyle = glow; ctx.fillRect(-size / 2, -size / 2, size, size);

    // radial FFT telemetry ring (outer)
    const bars = 96, rT = R * 1.5;
    ctx.shadowBlur = 6;
    for (let i = 0; i < bars; i++) {
      let amp;
      if (this.freq && (this.state === 'listening' || this.state === 'speaking')) amp = this.freq[Math.floor((i / bars) * (this.freq.length * 0.75))] / 255;
      else amp = 0.05 + 0.05 * Math.abs(Math.sin(i * 0.5 + t * 1.6));
      const len = R * (0.04 + amp * 0.42), a = (i / bars) * Math.PI * 2;
      ctx.strokeStyle = col(0.25 + amp * 0.6); ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * rT, Math.sin(a) * rT); ctx.lineTo(Math.cos(a) * (rT + len), Math.sin(a) * (rT + len)); ctx.stroke();
    }

    // outer guide rings + tick gauges
    const ring = (radius, w, alpha, blur) => { ctx.shadowBlur = blur; ctx.strokeStyle = col(alpha); ctx.lineWidth = w; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke(); };
    ring(rT, 1, 0.28, 4);
    ring(R * 1.18, 2, 0.7, 12);
    // 3 gauge notches at the cardinal-ish points (geometry only; labels live in the DOM HUD)
    ctx.shadowBlur = 10; ctx.lineWidth = 3; ctx.strokeStyle = col(0.85);
    for (const ang of [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]) { ctx.beginPath(); ctx.moveTo(Math.cos(ang) * (R * 1.18), Math.sin(ang) * (R * 1.18)); ctx.lineTo(Math.cos(ang) * (R * 1.30), Math.sin(ang) * (R * 1.30)); ctx.stroke(); }

    // rotating segmented inner ring
    ctx.shadowBlur = 10; ctx.lineWidth = 2.5; ctx.strokeStyle = col(0.6);
    for (let i = 0; i < 5; i++) { const a0 = (i / 5) * Math.PI * 2 + this.spin * 0.6; ctx.beginPath(); ctx.arc(0, 0, R * 0.95, a0 + 0.12, a0 + Math.PI / 2.5 - 0.12); ctx.stroke(); }
    // counter-rotating fine ticks
    ctx.lineWidth = 2; ctx.strokeStyle = col(0.4);
    for (let i = 0; i < 30; i++) { const a = (i / 30) * Math.PI * 2 - this.spin * 1.3; ctx.beginPath(); ctx.moveTo(Math.cos(a) * R * 0.66, Math.sin(a) * R * 0.66); ctx.lineTo(Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72); ctx.stroke(); }

    // thinking: two indeterminate compute-arcs (no fake %)
    if (this.state === 'thinking') {
      ctx.shadowBlur = 14; ctx.lineWidth = 3; ctx.strokeStyle = col(0.95);
      const a = this.spin * 2.4;
      ctx.beginPath(); ctx.arc(0, 0, R * 1.34, a, a + 1.1); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R * 1.34, a + Math.PI, a + Math.PI + 1.1); ctx.stroke();
    }

    // radar sweep with alpha trail
    const sweep = (t * 0.6) % (Math.PI * 2);
    const grad = ctx.createConicGradient ? null : null;
    ctx.save(); ctx.rotate(sweep);
    const sw = ctx.createLinearGradient(0, 0, R * 1.18, 0);
    sw.addColorStop(0, col(0)); sw.addColorStop(1, col(0.5));
    ctx.strokeStyle = sw; ctx.lineWidth = 2; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(R * 1.18, 0); ctx.stroke();
    ctx.restore();

    // pulsing core
    const coreR = R * (0.42 + lvl * 0.22), core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, col(0.98)); core.addColorStop(0.6, col(0.5 + lvl * 0.3)); core.addColorStop(1, col(0));
    ctx.shadowBlur = 30; ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, coreR, 0, Math.PI * 2); ctx.fill();
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
