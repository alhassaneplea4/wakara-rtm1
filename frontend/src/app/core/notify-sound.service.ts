import { Injectable, signal } from '@angular/core';

const KEY = 'wk.notify.sound';

/**
 * Short chime played when new work reaches the user. The sound is synthesised (no audio file to ship) and can be
 * switched off from the notification menu; the choice is remembered on this browser.
 *
 * Browsers only allow sound after a user gesture: the audio context is therefore created / resumed on the
 * first click or key press made in the application, which happens at sign-in.
 */
@Injectable({ providedIn: 'root' })
export class NotifySoundService {
  readonly enabled = signal(NotifySoundService.read());
  private ctx: AudioContext | null = null;

  constructor() {
    const unlock = () => { this.context()?.resume().catch(() => undefined); };
    for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlock, { passive: true });
  }

  toggle() {
    const next = !this.enabled();
    this.enabled.set(next);
    try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* storage unavailable: the choice lasts for this visit */ }
    if (next) this.play();   // let the user hear what they just switched on
  }

  /** Two soft notes. Silent when switched off, or when the browser has not allowed sound yet. */
  play() {
    if (!this.enabled()) return;
    const ctx = this.context();
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    [[880, 0], [1175, 0.16]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + 0.4);
    });
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try { this.ctx = new Ctor(); } catch { return null; }
    return this.ctx;
  }

  private static read(): boolean {
    try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
  }
}
