// A round of applause on Save (Sky, 2026-09-04: "when you hit submit, i'd like
// an applause sound"). Synthesised with the Web Audio API — no audio file to
// ship, nothing to download, works offline. ~1.4 s of overlapping short noise
// bursts (claps) under a soft room-noise swell, fading out.
//
// Mute: localStorage.setItem('brix.applause', 'off'). Browsers only allow
// sound after a user gesture; a Save click is one, so this never fires
// silently-blocked on load.

let ctx: AudioContext | null = null;

export function applauseEnabled(): boolean {
  try { return localStorage.getItem('brix.applause') !== 'off'; } catch { return true; }
}
export function setApplauseEnabled(on: boolean): void {
  try { localStorage.setItem('brix.applause', on ? 'on' : 'off'); } catch { /* private window */ }
}

export function playApplause(): void {
  if (!applauseEnabled()) return;
  try {
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    ctx = ctx ?? new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(0.9, t0 + 0.08);
    master.gain.setValueAtTime(0.9, t0 + 0.9);
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
    master.connect(ctx.destination);

    // one shared noise buffer, band-passed like hands rather than hiss
    const len = Math.floor(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);

    const claps = 70;
    for (let i = 0; i < claps; i++) {
      const at = t0 + Math.random() * 1.3;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 0.8 + Math.random() * 0.6;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + Math.random() * 1800;
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = 0.12 + Math.random() * 0.2;
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(at);
      src.stop(at + 0.08);
    }
  } catch { /* audio is decoration */ }
}
