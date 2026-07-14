/**
 * A short "paid" chime, synthesised with WebAudio so the repo ships no binary asset
 * and works offline. Every call is best-effort: if the AudioContext is unavailable or
 * the browser blocks autoplay until a user gesture, it fails silently — the POS screen
 * still flips to PAID, it just does so without sound.
 */
export function playPaidChime(): void {
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void ctx.resume();

    const now = ctx.currentTime;
    // A rising two-note tap: G5 -> C6, the "ping" of a register accepting payment.
    const notes = [
      { freq: 784, at: 0, dur: 0.12 },
      { freq: 1047, at: 0.1, dur: 0.28 },
    ];

    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0.0001, now + n.at);
      gain.gain.exponentialRampToValueAtTime(0.22, now + n.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + n.at);
      osc.stop(now + n.at + n.dur + 0.02);
    }

    setTimeout(() => void ctx.close().catch(() => {}), 700);
  } catch {
    // no audio — silent, by design
  }
}
