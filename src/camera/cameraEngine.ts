import { CancelledError, isEmbedded } from '../audio/micErrors';
import { MotionTracker, rgbaToGray } from './motionCore';

export type CameraFacing = 'environment' | 'user';

export type CameraProblem = 'insecure' | 'unsupported' | 'embedded' | 'denied' | 'notfound' | 'busy' | 'lost' | 'unknown';

export interface CameraError {
  problem: CameraProblem;
  title: string;
  action: string;
}

export class CameraAccessError extends Error {
  readonly info: CameraError;
  constructor(info: CameraError) {
    super(info.title);
    this.info = info;
  }
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
}

/** Kamera-Probleme sind nie fatal: die App zählt dann sichtbar nur mit Ton weiter. */
export function cameraError(problem: CameraProblem): CameraError {
  const tail = ' Bis dahin zählt die App nur mit Ton.';
  switch (problem) {
    case 'insecure':
      return { problem, title: 'Kamera braucht eine sichere Adresse.', action: 'Öffne die App über den https-Link.' + tail };
    case 'unsupported':
      return { problem, title: 'Hier ist keine Kamera verfügbar.', action: 'Öffne die App in Safari (iPhone) oder Chrome (Android).' + tail };
    case 'embedded':
      return { problem, title: 'Die Vorschau blockiert die Kamera.', action: 'Öffne den Link direkt in Safari oder Chrome.' + tail };
    case 'denied':
      return {
        problem,
        title: 'Kamera ist nicht erlaubt.',
        action: (isIOS()
          ? 'In Safari links in der Adressleiste auf „aA“ tippen → Website-Einstellungen → Kamera → Erlauben. Dann neu laden.'
          : 'In Chrome auf das Symbol links neben der Adresse tippen → Berechtigungen → Kamera erlauben. Dann neu laden.') + tail,
      };
    case 'notfound':
      return { problem, title: 'Keine Kamera gefunden.', action: 'Unter „Anpassen“ die andere Kamera wählen.' + tail };
    case 'busy':
      return { problem, title: 'Die Kamera wird gerade anderweitig genutzt.', action: 'Andere Kamera-App schließen und auf „Fortsetzen“ oder „Neue Runde“ tippen.' + tail };
    case 'lost':
      return { problem, title: 'Die Kamera liefert keine Bilder mehr.', action: 'Kamera freihalten. Bei der nächsten Runde wird sie neu gestartet.' + tail };
    default:
      return { problem: 'unknown', title: 'Kamera konnte nicht gestartet werden.', action: 'Seite neu laden und erneut versuchen.' + tail };
  }
}

export function classifyCameraError(err: unknown): CameraError {
  if (err instanceof CameraAccessError) return err.info;
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return cameraError(isEmbedded() ? 'embedded' : 'denied');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return cameraError('notfound');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return cameraError('busy');
    default:
      return cameraError('unknown');
  }
}

/** Schnittstelle, über die die Spiellogik die Kamera nutzt. */
export interface CameraPort {
  ensure(facing: CameraFacing): Promise<void>;
  isLive(): boolean;
  /** Höchster Bewegungswert im Fenster (performance.now-Zeitbasis); null = keine Bilder. */
  peak(t0: number, t1: number): number | null;
  /** Übliche Bewegung (Quantil) im Fenster; null = keine Bilder. */
  typical(t0: number, t1: number): number | null;
  release(): void;
  onInterrupted: (() => void) | null;
}

const SAMPLE_LONG = 128;
const SAMPLE_SHORT = 96;

/**
 * Kamerazugriff mit kleiner, flüchtiger Bildauswertung.
 * Keine Aufnahme, kein Upload: jedes Bild wird nur mit dem vorigen verglichen.
 */
export class CameraEngine implements CameraPort {
  onInterrupted: (() => void) | null = null;
  /** Wird nach jedem ausgewerteten Bild aufgerufen (Vorschau-Anzeige). */
  onFrame: ((score: number) => void) | null = null;

  readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private stream: MediaStream | null = null;
  private tracker: MotionTracker | null = null;
  private gray: Uint8Array | null = null;
  private facing: CameraFacing | null = null;
  private epoch = 0;
  private live = false;
  private startPromise: Promise<void> | null = null;
  private loopHandle: number | null = null;
  private usesVfc = false;
  private lastVideoTime = -1;
  private watchdog: number | null = null;
  private frames = 0;
  info: { width: number; height: number; fps: number | null; facing: CameraFacing } | null = null;

  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.setAttribute('aria-hidden', 'true');
    v.className = 'cam-video';
    this.video = v;
    this.canvas = document.createElement('canvas');
  }

  get frameCount(): number {
    return this.frames;
  }

  get lastScore(): number {
    return this.tracker?.lastScore ?? 0;
  }

  get lastPeakCell(): { col: number; row: number; cols: number; rows: number } | null {
    const t = this.tracker;
    if (!t || t.lastPeakCell < 0) return null;
    return { col: t.lastPeakCell % t.cols, row: Math.floor(t.lastPeakCell / t.cols), cols: t.cols, rows: t.rows };
  }

  isLive(): boolean {
    return this.live && this.stream?.getVideoTracks()[0]?.readyState === 'live';
  }

  peak(t0: number, t1: number): number | null {
    return this.tracker?.peak(t0, t1) ?? null;
  }

  typical(t0: number, t1: number): number | null {
    return this.tracker?.quantile(t0, t1, 0.75) ?? null;
  }

  ensure(facing: CameraFacing): Promise<void> {
    if (this.isLive() && this.facing === facing) return Promise.resolve();
    if (this.startPromise && this.facing === facing) return this.startPromise;
    if (this.stream || this.startPromise) this.release();
    if (window.isSecureContext === false) return Promise.reject(new CameraAccessError(cameraError('insecure')));
    if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new CameraAccessError(cameraError('unsupported')));
    this.facing = facing;
    const myEpoch = ++this.epoch;
    this.startPromise = this.setup(facing, myEpoch).finally(() => {
      if (this.epoch === myEpoch) this.startPromise = null;
    });
    return this.startPromise;
  }

  private async setup(facing: CameraFacing, myEpoch: number): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60, max: 60 },
        },
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'OverconstrainedError' || name === 'TypeError') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        } catch (err2) {
          if (this.epoch === myEpoch) this.release();
          throw new CameraAccessError(classifyCameraError(err2));
        }
      } else {
        if (this.epoch === myEpoch) this.release();
        throw new CameraAccessError(classifyCameraError(err));
      }
    }
    if (this.epoch !== myEpoch) {
      stream.getTracks().forEach((t) => t.stop());
      throw new CancelledError();
    }
    this.stream = stream;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {
      /* iOS: stummes Inline-Video darf ohne Geste spielen; sonst kommt es beim nächsten Tippen */
    }
    if (this.video.readyState < 1) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        this.video.addEventListener('loadedmetadata', done, { once: true });
        window.setTimeout(done, 3000);
      });
    }
    if (this.epoch !== myEpoch) throw new CancelledError();

    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    const portrait = vh > vw;
    const w = portrait ? SAMPLE_SHORT : SAMPLE_LONG;
    const h = portrait ? SAMPLE_LONG : SAMPLE_SHORT;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx2d = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!this.ctx2d) {
      this.release();
      throw new CameraAccessError(cameraError('unsupported'));
    }
    this.tracker = new MotionTracker(w, h, 8);
    this.gray = new Uint8Array(w * h);
    const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    this.info = { width: vw, height: vh, fps: typeof settings.frameRate === 'number' ? Math.round(settings.frameRate) : null, facing };

    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', this.handleLost);
    this.live = true;
    this.frames = 0;
    this.startLoop(myEpoch);
    let lastCount = 0;
    let lastChange = performance.now();
    this.watchdog = window.setInterval(() => {
      if (!this.live || document.visibilityState !== 'visible') return;
      if (this.frames !== lastCount) {
        lastCount = this.frames;
        lastChange = performance.now();
      } else if (performance.now() - lastChange > 2500) {
        this.handleLost();
      }
    }, 1000);
  }

  private startLoop(myEpoch: number): void {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    this.usesVfc = typeof v.requestVideoFrameCallback === 'function';
    const onFrame = (now: number): void => {
      if (this.epoch !== myEpoch || !this.live) return;
      this.sample(now);
      schedule();
    };
    const schedule = (): void => {
      if (this.usesVfc) this.loopHandle = v.requestVideoFrameCallback!(onFrame);
      else
        this.loopHandle = window.requestAnimationFrame((now) => {
          // nur neue Kamerabilder auswerten
          if (this.video.currentTime !== this.lastVideoTime) {
            this.lastVideoTime = this.video.currentTime;
            onFrame(now);
          } else schedule();
        });
    };
    schedule();
  }

  private sample(now: number): void {
    if (!this.ctx2d || !this.tracker || !this.gray) return;
    try {
      this.ctx2d.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      const img = this.ctx2d.getImageData(0, 0, this.canvas.width, this.canvas.height);
      rgbaToGray(img.data, this.gray);
    } catch {
      return;
    }
    const score = this.tracker.process(this.gray, now);
    this.frames++;
    this.onFrame?.(score);
  }

  private readonly handleLost = (): void => {
    if (!this.live) return;
    this.live = false;
    this.onInterrupted?.();
  };

  release(): void {
    this.epoch++;
    this.live = false;
    this.startPromise = null;
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.loopHandle !== null) {
      const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
      if (this.usesVfc) v.cancelVideoFrameCallback?.(this.loopHandle);
      else window.cancelAnimationFrame(this.loopHandle);
    }
    this.loopHandle = null;
    const track = this.stream?.getVideoTracks()[0];
    track?.removeEventListener('ended', this.handleLost);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.tracker?.reset();
    this.tracker = null;
    this.gray = null;
    this.ctx2d = null;
    this.lastVideoTime = -1;
  }
}
