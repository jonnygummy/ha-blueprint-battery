import type { WakeLockPort } from './controller';

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: 'release', fn: () => void): void;
}

/** Bildschirm während des Spiels anlassen, falls der Browser es kann. */
export class ScreenWakeLock implements WakeLockPort {
  readonly supported: boolean;
  private wanted = false;
  private sentinel: Sentinel | null = null;
  private pending = false;

  constructor() {
    this.supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    if (this.supported) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.wanted && !this.sentinel) this.acquire();
      });
    }
  }

  request(): void {
    this.wanted = true;
    if (this.supported && !this.sentinel) this.acquire();
  }

  release(): void {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s) void s.release().catch(() => undefined);
  }

  private acquire(): void {
    if (this.pending || document.visibilityState !== 'visible') return;
    this.pending = true;
    const wl = (navigator as unknown as { wakeLock: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock;
    wl.request('screen')
      .then((s) => {
        this.pending = false;
        if (!this.wanted) {
          void s.release().catch(() => undefined);
          return;
        }
        this.sentinel = s;
        s.addEventListener('release', () => {
          if (this.sentinel === s) this.sentinel = null;
        });
      })
      .catch(() => {
        // Fehlender Wake Lock verhindert das Spielen nicht.
        this.pending = false;
      });
  }
}
