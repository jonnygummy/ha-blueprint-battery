/**
 * Impulsdetektor für Ball-Schläger-Kontakte.
 *
 * Reine Logik ohne Browser-Abhängigkeiten: läuft im AudioWorklet, im
 * ScriptProcessor-Fallback und in Node-Tests mit synthetischen Signalen.
 *
 * Verarbeitung je Block:
 *  1. Zwei kaskadierte Butterworth-Hochpässe (24 dB/Oktave) dämpfen Wind und Rumpeln.
 *  2. Kurzzeitenergie in 5-ms-Frames (abhängig von der tatsächlichen Sample-Rate).
 *  3. Auslösung nur, wenn Pegel über Hintergrund + Schwelle UND schneller Anstieg.
 *  4. Hysterese + Sperrzeit verhindern Mehrfachzählungen eines Impulses.
 *  5. Hintergrundpegel wird langsam nachgeführt; Impulse sind davon ausgeschlossen.
 *
 * Alle Werte sind abstimmbare Ausgangswerte, keine universell zuverlässigen Einstellungen.
 */

export interface DetectorConfig {
  /** Pegel über Hintergrund (dB), ab dem ein Impuls zählen kann. */
  thresholdDb: number;
  /** Mindestanstieg (dB) gegenüber den Frames 15–40 ms davor. */
  riseDb: number;
  /** Abstand unter der Schwelle (dB), ab dem ein Impuls als beendet gilt. */
  hysteresisDb: number;
  /** Sperrzeit nach einem gezählten Impuls (ms). */
  refractoryMs: number;
  /** Grenzfrequenz des Hochpasses (Hz). */
  highpassHz: number;
}

export type DetectorMode = 'idle' | 'calibrate' | 'detect';

export interface CalibrationResult {
  floorDb: number;
  spreadDb: number;
  frames: number;
  /** false, wenn das Mikrofon praktisch kein Signal liefert. */
  hasSignal: boolean;
}

export interface LevelSnapshot {
  /** Höchster ungefilterter Frame-Pegel seit der letzten Abfrage (dBFS). */
  rawDb: number;
  /** Höchster gefilterter Frame-Pegel seit der letzten Abfrage (dBFS). */
  filteredDb: number;
  floorDb: number;
}

export const SENSITIVITY_MIN = 1;
export const SENSITIVITY_MAX = 10;
export const SENSITIVITY_DEFAULT = 6;

/** Ordnet den Empfindlichkeitsregler (1–10) den Erkennungsschwellen zu. */
export function configFromSensitivity(sensitivity: number): DetectorConfig {
  const s = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, sensitivity));
  const thresholdDb = 30 - 2.4 * s; // 1 → 27.6 dB … 6 → 15.6 dB … 10 → 6 dB
  return {
    thresholdDb,
    riseDb: Math.max(5, thresholdDb * 0.7),
    hysteresisDb: Math.min(6, thresholdDb / 2),
    refractoryMs: 180,
    highpassHz: 900,
  };
}

const FRAME_SEC = 0.005;
const SILENCE_DB = -120;
const RISE_REF_FROM = 3; // Frames zurück (15 ms)
const RISE_REF_TO = 8; // Frames zurück (40 ms)
const RELEASE_GUARD_MS = 60; // nach Ende eines Impulses kurz nicht in Hintergrund einrechnen
const LONG_ACTIVE_MS = 1500; // Dauerlärm: Hintergrund darf sich anpassen
const FLOOR_UP_TAU = 4; // s
const FLOOR_DOWN_TAU = 1.5; // s
const FLOOR_FAST_TAU = 0.4; // s, nur bei Dauerlärm

class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  setHighpass(sampleRate: number, freq: number, q = Math.SQRT1_2): void {
    const f = Math.min(freq, sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function toDb(meanSquare: number): number {
  return meanSquare > 1e-12 ? 10 * Math.log10(meanSquare) : SILENCE_DB;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return SILENCE_DB;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

export class DetectorCore {
  readonly sampleRate: number;
  readonly frameSize: number;
  private readonly frameMs: number;
  private config: DetectorConfig;
  private mode: DetectorMode = 'idle';

  private readonly hp1 = new Biquad();
  private readonly hp2 = new Biquad();

  private frameSumFiltered = 0;
  private frameSumRaw = 0;
  private frameCount = 0;
  private frameIndex = 0;

  /** Ringpuffer der letzten gefilterten Frame-Pegel. */
  private readonly history: number[] = new Array(RISE_REF_TO + 1).fill(SILENCE_DB);
  private historyPos = 0;

  private floorDb = -70;
  private spreadDb = 0;
  private calibrationFrames: number[] = [];

  private active = false;
  private activeSinceFrame = 0;
  private lastHitFrame = -1e9;
  private releaseFrame = -1e9;
  private peakDb = SILENCE_DB;

  private levelRawMax = SILENCE_DB;
  private levelFilteredMax = SILENCE_DB;

  constructor(sampleRate: number, config: DetectorConfig) {
    this.sampleRate = sampleRate;
    this.frameSize = Math.max(16, Math.round(sampleRate * FRAME_SEC));
    this.frameMs = (this.frameSize / sampleRate) * 1000;
    this.config = config;
    this.applyFilter();
  }

  setConfig(config: DetectorConfig): void {
    const filterChanged = config.highpassHz !== this.config.highpassHz;
    this.config = config;
    if (filterChanged) this.applyFilter();
  }

  getConfig(): DetectorConfig {
    return this.config;
  }

  setMode(mode: DetectorMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'calibrate') this.calibrationFrames = [];
    if (mode === 'detect') {
      this.active = false;
      this.lastHitFrame = -1e9;
      this.releaseFrame = -1e9;
    }
  }

  getMode(): DetectorMode {
    return this.mode;
  }

  setFloor(floorDb: number, spreadDb = this.spreadDb): void {
    this.floorDb = floorDb;
    this.spreadDb = spreadDb;
  }

  getFloor(): number {
    return this.floorDb;
  }

  /** Schwelle inklusive Zuschlag für schwankende Umgebung (z. B. böiger Wind). */
  effectiveThresholdDb(): number {
    const extra = Math.min(10, Math.max(0, this.spreadDb - 4)) * 0.5;
    return this.config.thresholdDb + extra;
  }

  /** Beendet die Kalibrierung und übernimmt den gemessenen Hintergrund. */
  finishCalibration(): CalibrationResult {
    const frames = this.calibrationFrames.slice().sort((a, b) => a - b);
    const median = percentile(frames, 0.5);
    const p90 = percentile(frames, 0.9);
    const hasSignal = frames.length > 0 && median > -110;
    const result: CalibrationResult = {
      floorDb: hasSignal ? median : -70,
      spreadDb: hasSignal ? Math.max(0, p90 - median) : 0,
      frames: frames.length,
      hasSignal,
    };
    this.setFloor(result.floorDb, result.spreadDb);
    this.calibrationFrames = [];
    this.mode = 'idle';
    return result;
  }

  calibrationFrameCount(): number {
    return this.calibrationFrames.length;
  }

  takeLevel(): LevelSnapshot {
    const snap = { rawDb: this.levelRawMax, filteredDb: this.levelFilteredMax, floorDb: this.floorDb };
    this.levelRawMax = SILENCE_DB;
    this.levelFilteredMax = SILENCE_DB;
    return snap;
  }

  /**
   * Verarbeitet einen Block Mono-Samples.
   * Gibt die Anzahl erkannter Impulse in diesem Block zurück (meist 0 oder 1).
   */
  process(samples: Float32Array): number {
    let hits = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = this.hp2.step(this.hp1.step(x));
      this.frameSumRaw += x * x;
      this.frameSumFiltered += y * y;
      this.frameCount++;
      if (this.frameCount >= this.frameSize) {
        if (this.endFrame()) hits++;
      }
    }
    return hits;
  }

  private applyFilter(): void {
    this.hp1.setHighpass(this.sampleRate, this.config.highpassHz);
    this.hp2.setHighpass(this.sampleRate, this.config.highpassHz);
    this.hp1.reset();
    this.hp2.reset();
  }

  private msToFrames(ms: number): number {
    return ms / this.frameMs;
  }

  /** Schließt einen Frame ab. true = Impuls gezählt. */
  private endFrame(): boolean {
    const rawDb = toDb(this.frameSumRaw / this.frameCount);
    const db = toDb(this.frameSumFiltered / this.frameCount);
    this.frameSumRaw = 0;
    this.frameSumFiltered = 0;
    this.frameCount = 0;
    const f = this.frameIndex++;

    if (rawDb > this.levelRawMax) this.levelRawMax = rawDb;
    if (db > this.levelFilteredMax) this.levelFilteredMax = db;

    // Referenz für den Anstieg: Mittel der Frames 15–40 ms zuvor.
    const len = this.history.length;
    let refSum = 0;
    let refN = 0;
    for (let back = RISE_REF_FROM; back <= RISE_REF_TO; back++) {
      refSum += this.history[(this.historyPos - back + len * 4) % len];
      refN++;
    }
    const refDb = refSum / refN;
    this.history[this.historyPos] = db;
    this.historyPos = (this.historyPos + 1) % len;

    if (this.mode === 'calibrate') {
      this.calibrationFrames.push(db);
      return false;
    }
    if (this.mode !== 'detect') return false;

    const threshold = this.effectiveThresholdDb();
    const onLevel = this.floorDb + threshold;
    const offLevel = onLevel - this.config.hysteresisDb;
    const refractoryFrames = this.msToFrames(this.config.refractoryMs);
    const sinceHit = f - this.lastHitFrame;

    let counted = false;
    if (this.active) {
      if (db > this.peakDb) this.peakDb = db;
      const decayed = db < this.peakDb - 15;
      if (sinceHit >= refractoryFrames && (db < offLevel || decayed)) {
        this.active = false;
        this.releaseFrame = f;
      }
    } else if (sinceHit >= refractoryFrames && db >= onLevel && db - refDb >= this.config.riseDb) {
      this.active = true;
      this.activeSinceFrame = f;
      this.lastHitFrame = f;
      this.peakDb = db;
      counted = true;
    }

    this.trackFloor(db, f, onLevel);
    return counted;
  }

  /** Langsame Nachführung des Hintergrundpegels; Impulse bleiben außen vor. */
  private trackFloor(db: number, f: number, onLevel: number): void {
    const dt = this.frameMs / 1000;
    if (this.active) {
      // Dauerlärm (z. B. Windböe, Motor): nach 1,5 s darf sich der Hintergrund anpassen.
      if (f - this.activeSinceFrame > this.msToFrames(LONG_ACTIVE_MS)) {
        this.floorDb += (1 - Math.exp(-dt / FLOOR_FAST_TAU)) * (db - this.floorDb);
      }
      return;
    }
    if (f - this.releaseFrame < this.msToFrames(RELEASE_GUARD_MS)) return;
    const target = Math.min(db, onLevel); // einzelne Spitzen ziehen den Hintergrund kaum hoch
    const tau = target > this.floorDb ? FLOOR_UP_TAU : FLOOR_DOWN_TAU;
    this.floorDb += (1 - Math.exp(-dt / tau)) * (target - this.floorDb);
  }
}
