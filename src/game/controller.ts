import type { AudioPort, LevelInfo } from '../audio/audioEngine';
import { CAMERA_CANDIDATE_BOOST_DB, SENSITIVITY_DEFAULT } from '../audio/detectorCore';
import { CancelledError, MicAccessError, classifyGetUserMediaError, type MicError } from '../audio/micErrors';
import { cameraError, classifyCameraError, type CameraError, type CameraFacing, type CameraPort } from '../camera/cameraEngine';
import { MOTION_SENSITIVITY_DEFAULT, motionThreshold } from '../camera/motionCore';
import type { GameRecord, GameStore } from '../storage/gameStore';
import { HitFusion, emptyStats, type FusionDecision, type FusionOutcome, type FusionStats } from './fusion';

/** Explizite Zustände des Spielablaufs. */
export type Phase = 'ready' | 'calibrating' | 'countdown' | 'running' | 'interrupted' | 'stopped';
export type InterruptReason = 'hidden' | 'audio' | 'test' | 'recalibrate';

export interface Clock {
  /** Absolute Zeit (ms seit 1970). */
  now(): number;
  /** Monotone Zeit für Dauern (ms). */
  mono(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface WakeLockPort {
  readonly supported: boolean;
  request(): void;
  release(): void;
}

export interface DraftStorage {
  load(): string | null;
  save(value: string): void;
  clear(): void;
}

interface LiveGame {
  id: string;
  number: number;
  startTime: number;
  hits: number;
  activeMs: number;
  runningSince: number | null;
  saved: boolean;
  check: FusionStats;
  usedCamera: boolean;
}

export type CameraStatus = 'off' | 'starting' | 'live' | 'failed';

export interface Calibration {
  floorDb: number;
  spreadDb: number;
  at: number;
}

export interface TestState {
  count: number;
  listening: boolean;
  gen: number;
  check: FusionStats;
}

export type ChangeKind = 'state' | 'hit' | 'level' | 'games' | 'check';

export const CALIBRATION_MS = 3000;
export const CALIBRATION_MAX_AGE_MS = 10 * 60 * 1000;
export const COUNTDOWN_SECONDS = 3;
export const TEST_TARGET = 5;

const MSG_MIC = 'Mikrofon wird aktiviert …';
const MSG_MEASURE = 'Kurz nicht spielen – wir messen die Umgebung.';
const MSG_GO = 'Los geht’s!';

function makeId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class GameController {
  phase: Phase = 'ready';
  interruptReason: InterruptReason | null = null;
  message: string | null = null;
  countdown: number | null = null;
  error: MicError | null = null;
  info: string | null = null;
  calibration: Calibration | null = null;
  standaloneCalibrating = false;
  test: TestState | null = null;
  micCheck = false;
  level: LevelInfo | null = null;
  /** Gerade abgeschlossenes Spiel (für Korrekturen nach „Stopp“). */
  stoppedRecord: GameRecord | null = null;

  // Kamera-Bestätigung
  cameraEnabled = true;
  cameraFacing: CameraFacing = 'environment';
  cameraStatus: CameraStatus = 'off';
  cameraNotice: CameraError | null = null;
  /** Kamera nur zum Ausrichten geöffnet (ohne Spiel). */
  cameraCheck = false;
  audioSensitivity = SENSITIVITY_DEFAULT;
  motionSensitivity = MOTION_SENSITIVITY_DEFAULT;
  lastDecision: { outcome: FusionOutcome; at: number } | null = null;
  /** Letzte Entscheidungen der Kamera-Prüfung (Diagnose, nur im Speicher). */
  readonly decisionLog: FusionDecision[] = [];
  /** Letzte Ton-Ereignisse mit Stärke über Hintergrund (Diagnose, nur im Speicher). */
  readonly audioLog: { t: number; strengthDb: number }[] = [];
  private readonly fusion: HitFusion | null;

  private game: LiveGame | null = null;
  private gen = 0;
  private timers = new Set<number>();
  private messageTimer: number | null = null;
  private lastDraftAt = 0;
  private readonly listeners = new Set<(kind: ChangeKind) => void>();

  constructor(
    private readonly audio: AudioPort,
    private readonly store: GameStore,
    private readonly clock: Clock,
    private readonly wake: WakeLockPort,
    private readonly drafts: DraftStorage | null = null,
    private readonly camera: CameraPort | null = null,
  ) {
    audio.onHit = (gen, strengthDb) => {
      if (gen === this.gen) {
        this.audioLog.push({ t: this.clock.mono(), strengthDb });
        if (this.audioLog.length > 100) this.audioLog.shift();
      }
      this.handleHit(gen);
    };
    this.fusion = camera
      ? new HitFusion(clock, camera, (d) => this.handleDecision(d), motionThreshold(this.motionSensitivity))
      : null;
    if (camera) camera.onInterrupted = () => this.handleCameraLost();
    audio.onLevel = (lvl) => {
      this.level = lvl;
      this.emit('level');
    };
    audio.onInterrupted = () => this.handleAudioInterrupted();
  }

  // ---------- Beobachter ----------

  subscribe(fn: (kind: ChangeKind) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(kind: ChangeKind): void {
    for (const fn of this.listeners) fn(kind);
  }

  // ---------- Abfragen für die Oberfläche ----------

  get hits(): number {
    if (this.game && !this.game.saved) return this.game.hits;
    if (this.phase === 'stopped' && this.stoppedRecord) return this.stoppedRecord.hits;
    return 0;
  }

  get gameInProgress(): boolean {
    return !!this.game && !this.game.saved;
  }

  get currentNumber(): number | null {
    if (this.game) return this.game.number;
    return this.stoppedRecord?.number ?? null;
  }

  activeMs(): number {
    if (this.game && !this.game.saved) {
      const g = this.game;
      return g.activeMs + (g.runningSince !== null ? this.clock.mono() - g.runningSince : 0);
    }
    if (this.phase === 'stopped' && this.stoppedRecord) return this.stoppedRecord.activeMs;
    return 0;
  }

  canAdjust(): boolean {
    return this.gameInProgress || (this.phase === 'stopped' && !!this.stoppedRecord);
  }

  /** Ton-Kandidaten werden gerade von der Kamera geprüft. */
  get cameraActive(): boolean {
    return !!this.camera && this.cameraEnabled && this.cameraStatus === 'live' && this.camera.isLive();
  }

  /** Diagnose der Kamera-Bestätigung für das laufende/letzte Spiel bzw. den Schlagtest. */
  get checkStats(): FusionStats | null {
    if (this.test) return this.test.check;
    if (this.game && !this.game.saved) return this.game.usedCamera ? this.game.check : null;
    return this.stoppedRecord?.cameraCheck ?? null;
  }

  calibrationUsable(): boolean {
    return !!this.calibration && this.clock.mono() - this.calibration.at < CALIBRATION_MAX_AGE_MS;
  }

  // ---------- Aktionen ----------

  /** „Spiel starten“: misst immer zuerst die Umgebung. */
  start(): void {
    if (this.phase === 'calibrating' || this.phase === 'countdown' || this.gameInProgress) return;
    this.beginRound(true);
  }

  /** „Neue Runde“: schließt ein laufendes Spiel genau einmal ab und beginnt neu. */
  newRound(): void {
    if ((this.phase === 'calibrating' || this.phase === 'countdown') && !this.gameInProgress) return;
    if (this.gameInProgress) {
      this.gen++;
      this.stopDetection();
      this.finalize();
    }
    this.beginRound(false);
  }

  /** „Stopp“: Erkennung sofort beenden, Ergebnis einfrieren, genau einmal speichern. */
  stop(): void {
    if (this.gameInProgress) {
      this.gen++;
      this.clearTimers();
      this.stopDetection();
      if (this.test) this.test = null;
      this.finalize();
      this.phase = 'stopped';
      this.interruptReason = null;
      this.countdown = null;
      this.setMessage(null);
      this.wake.release();
      this.releaseAudioIfIdle();
      this.emit('state');
      return;
    }
    if (this.phase === 'calibrating' || this.phase === 'countdown') {
      this.cancelPreparation(null);
    }
  }

  /** „Fortsetzen“ nach Unterbrechung. Muss aus einer Nutzeraktion kommen. */
  resume(): void {
    if (this.phase !== 'interrupted' || !this.gameInProgress) return;
    const myGen = ++this.gen;
    this.clearTimers();
    if (this.test) this.endTest();
    this.error = null;
    this.interruptReason = null;
    this.phase = 'countdown';
    this.countdown = null;
    this.setMessage(MSG_MIC);
    this.wake.request();
    const ready = this.audio.ensure();
    this.startCamera();
    this.emit('state');
    ready
      .then(() => {
        if (myGen !== this.gen) return;
        if (this.calibration) this.audio.setFloor(this.calibration.floorDb, this.calibration.spreadDb);
        this.runCountdown(myGen, () => this.continueCounting(myGen, 'Weiter geht’s!'));
      })
      .catch((err) => {
        if (myGen !== this.gen || err instanceof CancelledError) return;
        this.phase = 'interrupted';
        this.interruptReason = 'audio';
        this.countdown = null;
        this.setMessage(null);
        this.error = toMicError(err);
        this.emit('state');
      });
  }

  /** Manuelle Korrektur; nie unter null. Nach „Stopp“ wird derselbe Datensatz aktualisiert. */
  adjust(delta: number): void {
    if (this.gameInProgress && this.game) {
      this.game.hits = Math.max(0, this.game.hits + delta);
      this.saveDraft(true);
      this.emit('hit');
      return;
    }
    if (this.phase === 'stopped' && this.stoppedRecord) {
      const updated = { ...this.stoppedRecord, hits: Math.max(0, this.stoppedRecord.hits + delta) };
      if (updated.hits === this.stoppedRecord.hits) return;
      this.stoppedRecord = updated;
      void this.persist(updated);
      this.emit('games');
    }
  }

  /** „Neu kalibrieren“. Ein laufendes Spiel pausiert dafür kurz. */
  recalibrate(): void {
    if (this.phase === 'calibrating' || this.phase === 'countdown' || this.standaloneCalibrating) return;
    if (this.test) this.endTest();
    const myGen = ++this.gen;
    this.error = null;
    const inGame = this.gameInProgress;
    if (inGame) {
      this.pauseClock();
      this.stopDetection();
      this.phase = 'calibrating';
      this.interruptReason = null;
      this.wake.request();
    } else {
      this.standaloneCalibrating = true;
    }
    this.setMessage(MSG_MIC);
    const ready = this.audio.ensure();
    if (inGame) this.startCamera();
    this.emit('state');
    ready
      .then(async () => {
        if (myGen !== this.gen) return;
        this.setMessage(MSG_MEASURE);
        this.emit('state');
        const res = await this.audio.calibrate(CALIBRATION_MS);
        if (myGen !== this.gen) return;
        this.calibration = { floorDb: res.floorDb, spreadDb: res.spreadDb, at: this.clock.mono() };
        if (inGame) {
          this.runCountdown(myGen, () => this.continueCounting(myGen, 'Weiter geht’s!'));
        } else {
          this.standaloneCalibrating = false;
          this.flashMessage('Umgebung gemessen.');
          this.releaseAudioIfIdle();
          this.emit('state');
        }
      })
      .catch((err) => {
        if (myGen !== this.gen || err instanceof CancelledError) return;
        this.error = toMicError(err);
        this.standaloneCalibrating = false;
        if (inGame) {
          this.phase = 'interrupted';
          this.interruptReason = 'audio';
        }
        this.setMessage(null);
        this.releaseAudioIfIdle();
        this.emit('state');
      });
  }

  /** Schlagtest: zählt separat, beeinflusst weder Spiel noch Verlauf. */
  startTest(): void {
    if (this.test || this.phase === 'calibrating' || this.phase === 'countdown' || this.standaloneCalibrating) return;
    if (this.phase === 'running') this.interrupt('test');
    const myGen = ++this.gen;
    this.error = null;
    this.test = { count: 0, listening: false, gen: myGen, check: emptyStats() };
    const ready = this.audio.ensure();
    this.startCamera();
    this.emit('state');
    ready
      .then(async () => {
        if (myGen !== this.gen || !this.test) return;
        if (!this.calibrationUsable()) {
          this.setMessage(MSG_MEASURE);
          this.emit('state');
          const res = await this.audio.calibrate(CALIBRATION_MS);
          if (myGen !== this.gen || !this.test) return;
          this.calibration = { floorDb: res.floorDb, spreadDb: res.spreadDb, at: this.clock.mono() };
          this.setMessage(null);
        } else if (this.calibration) {
          this.audio.setFloor(this.calibration.floorDb, this.calibration.spreadDb);
        }
        this.test.listening = true;
        this.audio.detect(myGen);
        this.emit('state');
      })
      .catch((err) => {
        if (myGen !== this.gen || err instanceof CancelledError) return;
        this.test = null;
        this.error = toMicError(err);
        this.setMessage(null);
        this.releaseAudioIfIdle();
        this.emit('state');
      });
  }

  endTest(): void {
    if (!this.test) return;
    this.test = null;
    this.gen++;
    this.stopDetection();
    if (this.message === MSG_MEASURE && !this.gameInProgress) this.setMessage(null);
    this.releaseAudioIfIdle();
    this.emit('state');
  }

  startMicCheck(): void {
    if (this.micCheck) return;
    this.micCheck = true;
    this.error = null;
    const ready = this.audio.ensure();
    this.emit('state');
    ready.then(() => this.emit('state')).catch((err) => {
      if (err instanceof CancelledError) return;
      this.micCheck = false;
      this.error = toMicError(err);
      this.emit('state');
    });
  }

  stopMicCheck(): void {
    if (!this.micCheck) return;
    this.micCheck = false;
    this.releaseAudioIfIdle();
    this.emit('state');
  }

  dismissError(): void {
    this.error = null;
    this.emit('state');
  }

  setSensitivity(value: number): void {
    this.audioSensitivity = value;
    this.applyAudioConfig();
  }

  setMotionSensitivity(value: number): void {
    this.motionSensitivity = value;
    if (this.fusion) this.fusion.threshold = motionThreshold(value);
  }

  /** Kamera-Bestätigung ein/aus. Aus einer Nutzeraktion aufrufen (Kamerastart). */
  setCameraEnabled(on: boolean): void {
    if (on === this.cameraEnabled) return;
    this.cameraEnabled = on;
    if (on) {
      if (this.devicesNeeded()) this.startCamera();
    } else {
      this.cameraCheck = false;
      this.camera?.release();
      this.cameraStatus = 'off';
      this.cameraNotice = null;
    }
    this.applyAudioConfig();
    this.emit('state');
  }

  setCameraFacing(facing: CameraFacing): void {
    if (facing === this.cameraFacing) return;
    this.cameraFacing = facing;
    if (this.camera && (this.cameraStatus === 'live' || this.cameraStatus === 'starting')) {
      this.camera.release();
      this.cameraStatus = 'off';
      this.startCamera();
    }
    this.emit('state');
  }

  /** Kamera nur zum Ausrichten öffnen. */
  startCameraCheck(): void {
    if (!this.camera || !this.cameraEnabled || this.cameraCheck) return;
    this.cameraCheck = true;
    this.startCamera();
    this.emit('state');
  }

  stopCameraCheck(): void {
    if (!this.cameraCheck) return;
    this.cameraCheck = false;
    this.releaseAudioIfIdle();
    this.emit('state');
  }

  dismissCameraNotice(): void {
    this.cameraNotice = null;
    this.emit('state');
  }

  /** App-Wechsel oder verborgener Tab. */
  handleHidden(): void {
    if (this.phase === 'running') {
      this.interrupt('hidden');
    } else if (this.phase === 'calibrating' || this.phase === 'countdown') {
      if (this.gameInProgress) {
        this.gen++;
        this.clearTimers();
        this.stopDetection();
        this.phase = 'interrupted';
        this.interruptReason = 'hidden';
        this.countdown = null;
        this.setMessage(null);
        this.emit('state');
      } else {
        this.cancelPreparation(null);
      }
    }
    if (this.test) this.endTest();
  }

  /** Regelmäßig von der Oberfläche aufgerufen (Timer-Anzeige, Sicherung). */
  tick(): void {
    if (this.phase === 'running' && this.clock.mono() - this.lastDraftAt > 5000) this.saveDraft(true);
  }

  /** Stellt ein Spiel wieder her, das durch Schließen der Seite nicht beendet wurde. */
  async recoverDraft(): Promise<void> {
    if (!this.drafts) return;
    const raw = this.drafts.load();
    if (!raw) return;
    try {
      const d = JSON.parse(raw) as GameRecord;
      if (d && typeof d.id === 'string' && !this.store.get(d.id) && Number.isFinite(d.startTime)) {
        const rec: GameRecord = {
          id: d.id,
          number: this.store.nextNumber(),
          startTime: d.startTime,
          endTime: d.endTime,
          activeMs: Math.max(0, d.activeMs),
          hits: Math.max(0, Math.round(d.hits)),
        };
        await this.persist(rec);
        this.info = `Spiel ${rec.number} wurde beim Schließen nicht beendet und ist jetzt gespeichert.`;
        this.emit('games');
        this.emit('state');
      }
    } catch {
      /* unlesbarer Entwurf: verwerfen */
    }
    this.drafts.clear();
  }

  // ---------- Interna ----------

  private beginRound(forceCalibrate: boolean): void {
    const myGen = ++this.gen;
    this.clearTimers();
    if (this.test) {
      this.test = null;
      this.stopDetection();
    }
    this.game = null;
    this.stoppedRecord = null;
    this.error = null;
    this.info = null;
    this.interruptReason = null;
    this.countdown = null;
    this.standaloneCalibrating = false;
    this.phase = 'calibrating';
    this.setMessage(MSG_MIC);
    this.wake.request();
    const ready = this.audio.ensure(); // synchron in der Nutzeraktion
    this.startCamera(); // parallel; wärmt sich während der Messung auf
    this.emit('state');
    ready
      .then(async () => {
        if (myGen !== this.gen) return;
        if (forceCalibrate || !this.calibrationUsable()) {
          this.setMessage(MSG_MEASURE);
          this.emit('state');
          const res = await this.audio.calibrate(CALIBRATION_MS);
          if (myGen !== this.gen) return;
          this.calibration = { floorDb: res.floorDb, spreadDb: res.spreadDb, at: this.clock.mono() };
          this.beginCounting(myGen);
        } else {
          const cal = this.calibration!;
          this.audio.setFloor(cal.floorDb, cal.spreadDb);
          this.runCountdown(myGen, () => this.beginCounting(myGen));
        }
      })
      .catch((err) => {
        if (myGen !== this.gen || err instanceof CancelledError) return;
        this.cancelPreparation(toMicError(err));
      });
  }

  private beginCounting(myGen: number): void {
    if (myGen !== this.gen) return;
    this.game = {
      id: makeId(),
      number: this.store.nextNumber(),
      startTime: this.clock.now(), // tatsächlicher Beginn der Zählung
      hits: 0,
      activeMs: 0,
      runningSince: this.clock.mono(),
      saved: false,
      check: emptyStats(),
      usedCamera: this.cameraActive,
    };
    this.phase = 'running';
    this.countdown = null;
    this.audio.detect(myGen);
    this.flashMessage(MSG_GO);
    this.saveDraft(true);
    this.emit('state');
  }

  private continueCounting(myGen: number, msg: string): void {
    if (myGen !== this.gen || !this.game) return;
    this.game.runningSince = this.clock.mono();
    this.phase = 'running';
    this.countdown = null;
    this.audio.detect(myGen);
    this.flashMessage(msg);
    this.emit('state');
  }

  private runCountdown(myGen: number, done: () => void): void {
    this.phase = 'countdown';
    this.setMessage(null);
    let n = COUNTDOWN_SECONDS;
    this.countdown = n;
    this.emit('state');
    const step = (): void => {
      if (myGen !== this.gen) return;
      n--;
      if (n <= 0) {
        this.countdown = null;
        done();
        return;
      }
      this.countdown = n;
      this.emit('state');
      this.schedule(step, 1000);
    };
    this.schedule(step, 1000);
  }

  private cancelPreparation(error: MicError | null): void {
    this.gen++;
    this.clearTimers();
    this.stopDetection();
    this.phase = 'ready';
    this.countdown = null;
    this.setMessage(null);
    this.error = error;
    this.wake.release();
    this.releaseAudioIfIdle();
    this.emit('state');
  }

  private interrupt(reason: InterruptReason): void {
    if (this.phase !== 'running') return;
    this.gen++;
    this.stopDetection();
    this.pauseClock();
    this.phase = 'interrupted';
    this.interruptReason = reason;
    this.setMessage(null);
    this.saveDraft(true);
    this.emit('state');
  }

  private handleAudioInterrupted(): void {
    if (this.phase === 'running') {
      this.interrupt('audio');
      return;
    }
    if (this.phase === 'calibrating' || this.phase === 'countdown') {
      if (this.gameInProgress) {
        this.gen++;
        this.clearTimers();
        this.phase = 'interrupted';
        this.interruptReason = 'audio';
        this.countdown = null;
        this.setMessage(null);
        this.emit('state');
      } else {
        this.cancelPreparation(classifyGetUserMediaError(new MicAccessError({
          problem: 'interrupted',
          title: 'Die Audioverarbeitung wurde unterbrochen.',
          action: 'Tippe erneut auf „Spiel starten“.',
        })));
      }
      return;
    }
    if (this.test) this.endTest();
    if (this.micCheck) {
      this.micCheck = false;
      this.emit('state');
    }
  }

  private pauseClock(): void {
    const g = this.game;
    if (g && g.runningSince !== null) {
      g.activeMs += this.clock.mono() - g.runningSince;
      g.runningSince = null;
    }
  }

  private handleHit(gen: number): void {
    if (gen !== this.gen) return; // verspätete Ereignisse alter Runden verwerfen
    const stats = this.targetStats(gen);
    if (!stats) return;
    if (this.cameraActive && this.fusion) {
      // Ton liefert nur einen Kandidaten; die Kamera entscheidet gleich.
      stats.candidates++;
      if (this.game && !this.game.saved && this.phase === 'running') this.game.usedCamera = true;
      this.fusion.submit(gen);
      this.emit('check');
      return;
    }
    this.countHit(gen);
  }

  private handleDecision(d: FusionDecision): void {
    if (d.gen !== this.gen) return; // Spiel inzwischen gestoppt oder pausiert
    const stats = this.targetStats(d.gen);
    if (!stats) return;
    if (d.outcome === 'confirmed') stats.confirmed++;
    else if (d.outcome === 'rejected') stats.rejected++;
    else stats.noCamera++;
    this.lastDecision = { outcome: d.outcome, at: this.clock.mono() };
    this.decisionLog.push(d);
    if (this.decisionLog.length > 50) this.decisionLog.shift();
    if (d.outcome !== 'rejected') this.countHit(d.gen);
    else this.emit('check');
  }

  private targetStats(gen: number): FusionStats | null {
    if (this.phase === 'running' && this.game && !this.game.saved) return this.game.check;
    if (this.test && this.test.listening && this.test.gen === gen) return this.test.check;
    return null;
  }

  private countHit(gen: number): void {
    if (this.phase === 'running' && this.game && !this.game.saved) {
      this.game.hits++;
      this.saveDraft(false);
      this.emit('hit');
      return;
    }
    if (this.test && this.test.listening && this.test.gen === gen) {
      this.test.count++;
      this.emit('hit');
    }
  }

  private stopDetection(): void {
    this.audio.detect(null);
    this.fusion?.cancelAll();
  }

  private startCamera(): void {
    const cam = this.camera;
    if (!cam || !this.cameraEnabled) return;
    if (this.cameraStatus === 'live' && cam.isLive()) return;
    this.cameraStatus = 'starting';
    cam
      .ensure(this.cameraFacing)
      .then(() => {
        if (!this.cameraEnabled || (!this.devicesNeeded() && !this.cameraCheck)) {
          cam.release();
          this.cameraStatus = 'off';
          return;
        }
        this.cameraStatus = 'live';
        this.cameraNotice = null;
        this.applyAudioConfig();
        this.emit('state');
      })
      .catch((err) => {
        if (err instanceof CancelledError) return;
        this.cameraStatus = 'failed';
        this.cameraNotice = classifyCameraError(err);
        this.cameraCheck = false;
        this.applyAudioConfig();
        this.emit('state');
      });
  }

  private handleCameraLost(): void {
    this.camera?.release();
    this.cameraStatus = 'failed';
    this.cameraNotice = cameraError('lost');
    this.cameraCheck = false;
    this.applyAudioConfig();
    this.emit('state');
  }

  /** Mit aktiver Kamera liefert der Ton empfindlichere Kandidaten. */
  private applyAudioConfig(): void {
    this.audio.setSensitivity(this.audioSensitivity, this.cameraActive ? CAMERA_CANDIDATE_BOOST_DB : 0);
  }

  /** Schließt das laufende Spiel genau einmal ab. */
  private finalize(): GameRecord | null {
    const g = this.game;
    if (!g || g.saved) return null;
    this.pauseClock();
    g.saved = true;
    const rec: GameRecord = {
      id: g.id,
      number: g.number,
      startTime: g.startTime,
      endTime: this.clock.now(),
      activeMs: Math.round(g.activeMs),
      hits: g.hits,
    };
    if (g.usedCamera) rec.cameraCheck = { ...g.check };
    if (this.level && this.calibration) {
      // nachgeführten Hintergrund für die nächste Runde merken
      this.calibration = { ...this.calibration, floorDb: this.level.floorDb };
    }
    this.stoppedRecord = rec;
    void this.persist(rec);
    this.drafts?.clear();
    this.emit('games');
    return rec;
  }

  private async persist(rec: GameRecord): Promise<void> {
    await this.store.put(rec);
    this.emit('games');
    this.emit('state');
  }

  private saveDraft(force: boolean): void {
    if (!this.drafts || !this.game || this.game.saved) return;
    if (!force && this.clock.mono() - this.lastDraftAt < 1000) return;
    this.lastDraftAt = this.clock.mono();
    const g = this.game;
    const draft: GameRecord = {
      id: g.id,
      number: g.number,
      startTime: g.startTime,
      endTime: this.clock.now(),
      activeMs: Math.round(this.activeMs()),
      hits: g.hits,
    };
    try {
      this.drafts.save(JSON.stringify(draft));
    } catch {
      /* ignore */
    }
  }

  private devicesNeeded(): boolean {
    return (
      this.phase === 'calibrating' ||
      this.phase === 'countdown' ||
      this.phase === 'running' ||
      this.phase === 'interrupted' ||
      !!this.test ||
      this.micCheck ||
      this.standaloneCalibrating
    );
  }

  /** Mikrofon und Kamera freigeben, sobald nichts sie mehr braucht. */
  private releaseAudioIfIdle(): void {
    const needed = this.devicesNeeded();
    if (!needed) this.audio.release();
    if (this.camera && !needed && !this.cameraCheck && this.cameraStatus !== 'off') {
      this.camera.release();
      if (this.cameraStatus !== 'failed') this.cameraStatus = 'off';
      this.applyAudioConfig();
    }
  }

  private setMessage(msg: string | null): void {
    if (this.messageTimer !== null) {
      this.clock.clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    this.message = msg;
  }

  private flashMessage(msg: string): void {
    this.setMessage(msg);
    this.messageTimer = this.clock.setTimeout(() => {
      this.messageTimer = null;
      if (this.message === msg) {
        this.message = null;
        this.emit('state');
      }
    }, 1600);
  }

  private schedule(fn: () => void, ms: number): void {
    const id = this.clock.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) this.clock.clearTimeout(id);
    this.timers.clear();
  }
}

function toMicError(err: unknown): MicError {
  return classifyGetUserMediaError(err);
}
