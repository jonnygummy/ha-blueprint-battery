import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioPort, LevelInfo } from '../src/audio/audioEngine';
import type { CalibrationResult } from '../src/audio/detectorCore';
import { GameController, type Clock, type DraftStorage, type WakeLockPort } from '../src/game/controller';
import { GameStore } from '../src/storage/gameStore';
import type { CameraFacing, CameraPort } from '../src/camera/cameraEngine';
import { CAMERA_CANDIDATE_BOOST_DB } from '../src/audio/detectorCore';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeClock implements Clock {
  t = Date.parse('2026-10-22T10:00:00Z');
  m = 0;
  private id = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now() {
    return this.t;
  }
  mono() {
    return this.m;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.id;
    this.timers.set(id, { at: this.m + ms, fn });
    return id;
  }
  clearTimeout(id: number) {
    this.timers.delete(id);
  }
  async advance(ms: number) {
    const end = this.m + ms;
    for (;;) {
      await flush();
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, tm] of this.timers) if (tm.at <= end && tm.at < nextAt) {
        nextAt = tm.at;
        nextId = id;
      }
      if (nextId < 0) break;
      const tm = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t += tm.at - this.m;
      this.m = tm.at;
      tm.fn();
    }
    this.t += end - this.m;
    this.m = end;
    await flush();
  }
}

/** Ersatz für das Mikrofon: kein echtes Audio, nur Protokollverhalten. */
class FakeAudio implements AudioPort {
  onHit: ((gen: number) => void) | null = null;
  onLevel: ((level: LevelInfo) => void) | null = null;
  onInterrupted: (() => void) | null = null;
  live = false;
  ensureCalls = 0;
  streamsOpened = 0;
  calibrateCalls = 0;
  releases = 0;
  detectGen: number | null = null;
  failNext: unknown = null;
  constructor(private readonly clock: FakeClock) {}
  ensure() {
    this.ensureCalls++;
    if (this.live) return Promise.resolve();
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return Promise.reject(e);
    }
    this.live = true;
    this.streamsOpened++;
    return Promise.resolve();
  }
  isLive() {
    return this.live;
  }
  calibrate(ms: number) {
    this.calibrateCalls++;
    return new Promise<CalibrationResult>((res) =>
      this.clock.setTimeout(() => res({ floorDb: -50, spreadDb: 2, frames: 600, hasSignal: true }), ms),
    );
  }
  setFloor() {}
  detect(gen: number | null) {
    this.detectGen = gen;
  }
  lastBoost = 0;
  setSensitivity(_s: number, boost = 0) {
    this.lastBoost = boost;
  }
  release() {
    this.releases++;
    this.live = false;
    this.detectGen = null;
  }
  /** simuliert einen erkannten Impuls aus dem Worklet */
  hit() {
    if (this.detectGen !== null) this.onHit?.(this.detectGen);
  }
  /** simuliert ein verspätet eintreffendes Ereignis einer alten Generation */
  lateHit(gen: number) {
    this.onHit?.(gen);
  }
}

class FakeWake implements WakeLockPort {
  supported = true;
  held = false;
  request() {
    this.held = true;
  }
  release() {
    this.held = false;
  }
}

class MemDrafts implements DraftStorage {
  v: string | null = null;
  load() {
    return this.v;
  }
  save(v: string) {
    this.v = v;
  }
  clear() {
    this.v = null;
  }
}

let factory: IDBFactory;
let clock: FakeClock;
let audio: FakeAudio;
let wake: FakeWake;
let drafts: MemDrafts;
let store: GameStore;
let c: GameController;

async function setup() {
  factory = new IDBFactory();
  clock = new FakeClock();
  audio = new FakeAudio(clock);
  wake = new FakeWake();
  drafts = new MemDrafts();
  store = new GameStore({ indexedDB: factory });
  await store.open();
  c = new GameController(audio, store, clock, wake, drafts);
}

async function reopenStore() {
  const s = new GameStore({ indexedDB: factory });
  await s.open();
  return s;
}

/** Spiel starten und bis zum Zählen vorspulen (3 s Kalibrierung). */
async function startAndRun() {
  c.start();
  await clock.advance(3000);
  expect(c.phase).toBe('running');
}

beforeEach(setup);

describe('Spielablauf', () => {
  it('Start: Kalibrierung zählt nicht, danach Zählen; Stopp speichert genau einmal', async () => {
    c.start();
    expect(c.phase).toBe('calibrating');
    await flush();
    audio.hit(); // Erkennung ist während der Kalibrierung aus
    audio.lateHit(999);
    await clock.advance(3000);
    expect(c.phase).toBe('running');
    expect(c.hits).toBe(0);
    const startedAt = clock.now();
    audio.hit();
    audio.hit();
    expect(c.hits).toBe(2);
    await clock.advance(5000);
    c.stop();
    c.stop();
    await flush();
    expect(c.phase).toBe('stopped');
    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0].hits).toBe(2);
    expect(all[0].startTime).toBe(startedAt); // Startzeit = tatsächlicher Zählbeginn
    expect(all[0].activeMs).toBe(5000);
    expect(audio.releases).toBeGreaterThan(0);
    expect(audio.live).toBe(false);
    expect(wake.held).toBe(false);
  });

  it('nach Stopp verändern verspätete Ereignisse den Zähler nicht', async () => {
    await startAndRun();
    const gen = audio.detectGen!;
    audio.hit();
    c.stop();
    audio.lateHit(gen);
    audio.hit();
    await flush();
    expect(c.hits).toBe(1);
    expect(store.all()[0].hits).toBe(1);
  });

  it('mehrfaches Tippen auf Start öffnet nur einen Mikrofonstrom', async () => {
    c.start();
    c.start();
    c.start();
    await clock.advance(3000);
    expect(audio.streamsOpened).toBe(1);
    expect(audio.calibrateCalls).toBe(1);
    expect(c.phase).toBe('running');
  });

  it('Abbruch vor Beginn der Zählung erzeugt kein Spiel', async () => {
    c.start();
    await clock.advance(1000);
    c.stop();
    await clock.advance(5000);
    expect(c.phase).toBe('ready');
    expect(store.all()).toHaveLength(0);
  });

  it('ein gestartetes Spiel mit null Schlägen wird gespeichert', async () => {
    await startAndRun();
    c.stop();
    await flush();
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].hits).toBe(0);
  });

  it('Neue Runde schließt das laufende Spiel einmal ab, nutzt die Kalibrierung und zählt nach Countdown', async () => {
    await startAndRun();
    audio.hit();
    c.newRound();
    c.newRound(); // Doppeltipp
    await flush();
    expect(store.all()).toHaveLength(1);
    expect(c.hits).toBe(0);
    expect(c.phase).toBe('countdown');
    audio.hit(); // Countdown zählt nicht
    await clock.advance(3000);
    expect(c.phase).toBe('running');
    expect(audio.calibrateCalls).toBe(1); // wiederverwendet
    audio.hit();
    audio.hit();
    c.stop();
    await flush();
    const all = store.all();
    expect(all.map((g) => g.hits)).toEqual([1, 2]);
    expect(all.map((g) => g.number)).toEqual([1, 2]);
  });

  it('Neue Runde nach Stopp speichert das gestoppte Spiel nicht erneut', async () => {
    await startAndRun();
    c.stop();
    await flush();
    c.newRound();
    await clock.advance(4000);
    expect(store.all()).toHaveLength(1);
    expect(c.phase).toBe('running');
  });

  it('veraltete Kalibrierung wird bei neuer Runde neu gemessen', async () => {
    await startAndRun();
    c.stop();
    await clock.advance(11 * 60 * 1000);
    c.newRound();
    await clock.advance(3000);
    expect(audio.calibrateCalls).toBe(2);
    expect(c.phase).toBe('running');
  });
});

describe('Unterbrechungen', () => {
  it('App-Wechsel pausiert, erhält den Zähler und zählt die Pause nicht als Spielzeit', async () => {
    await startAndRun();
    audio.hit();
    await clock.advance(10_000);
    c.handleHidden();
    expect(c.phase).toBe('interrupted');
    audio.hit(); // während der Pause
    await clock.advance(60_000);
    expect(c.activeMs()).toBe(10_000);
    c.resume();
    await clock.advance(3000); // Countdown
    expect(c.phase).toBe('running');
    await clock.advance(5000);
    audio.hit();
    c.stop();
    await flush();
    const g = store.all()[0];
    expect(g.hits).toBe(2);
    expect(g.activeMs).toBe(15_000);
  });

  it('Audio-Unterbrechung führt zu „Unterbrochen“ mit Fortsetzen', async () => {
    await startAndRun();
    audio.hit();
    audio.live = false;
    audio.onInterrupted?.();
    expect(c.phase).toBe('interrupted');
    expect(c.interruptReason).toBe('audio');
    c.resume();
    await clock.advance(3000);
    expect(c.phase).toBe('running');
    expect(audio.streamsOpened).toBe(2); // Mikrofon bei Fortsetzen neu aktiviert
    expect(c.hits).toBe(1);
  });

  it('Stopp während des Fortsetzen-Countdowns speichert das Spiel', async () => {
    await startAndRun();
    audio.hit();
    c.handleHidden();
    c.resume();
    await clock.advance(1000);
    c.stop();
    await flush();
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].hits).toBe(1);
  });

  it('verweigerte Berechtigung zeigt eine verständliche Meldung und erzeugt kein Spiel', async () => {
    audio.failNext = Object.assign(new Error('x'), { name: 'NotAllowedError' });
    // micErrors prüft, ob eingebettet – in Node gibt es kein window
    (globalThis as { window?: unknown }).window = { self: 1, top: 1 };
    (globalThis as { navigator?: unknown }).navigator ??= { userAgent: 'iPhone', maxTouchPoints: 5 };
    c.start();
    await flush();
    expect(c.phase).toBe('ready');
    expect(c.error?.problem).toBe('denied');
    expect(c.error?.action).toMatch(/Mikrofon/);
    expect(store.all()).toHaveLength(0);
  });
});

describe('Korrekturen und Schlagtest', () => {
  it('Korrektur nach Stopp aktualisiert denselben Datensatz, nie unter null', async () => {
    await startAndRun();
    audio.hit();
    c.stop();
    await flush();
    const id = store.all()[0].id;
    c.adjust(-1);
    c.adjust(-1);
    c.adjust(1);
    c.adjust(1);
    c.adjust(1);
    await flush();
    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(id);
    expect(all[0].hits).toBe(3);
    const reopened = await reopenStore();
    expect(reopened.all()[0].hits).toBe(3);
  });

  it('Schlagtest pausiert das Spiel und beeinflusst weder Zähler noch Verlauf', async () => {
    await startAndRun();
    audio.hit();
    c.startTest();
    await flush();
    expect(c.phase).toBe('interrupted');
    expect(c.interruptReason).toBe('test');
    expect(c.test?.listening).toBe(true); // Kalibrierung war frisch
    for (let i = 0; i < 5; i++) audio.hit();
    expect(c.test?.count).toBe(5);
    expect(c.hits).toBe(1);
    c.endTest();
    expect(c.phase).toBe('interrupted'); // ausdrückliches Fortsetzen nötig
    c.resume();
    await clock.advance(3000);
    audio.hit();
    c.stop();
    await flush();
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].hits).toBe(2);
  });
});

describe('Speicherung', () => {
  it('mehr als zehn Spiele bleiben nach Neuladen vollständig erhalten', async () => {
    for (let i = 0; i < 12; i++) {
      c.newRound();
      await clock.advance(i === 0 ? 3000 : 3000);
      for (let k = 0; k < i; k++) audio.hit();
      c.stop();
      await clock.advance(60_000);
    }
    const reopened = await reopenStore();
    const all = reopened.all();
    expect(all).toHaveLength(12);
    expect(all.map((g) => g.hits)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(all.map((g) => g.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(all.map((g) => g.id)).size).toBe(12);
  });

  it('Speicherfehler: Spielen geht weiter, Warnstatus wird gesetzt, keine Erfolgsmeldung', async () => {
    const broken = { open: () => { throw new Error('denied'); } } as unknown as IDBFactory;
    const s = new GameStore({ indexedDB: broken });
    await s.open();
    expect(s.persistent).toBe(false);
    const cc = new GameController(audio, s, clock, wake, drafts);
    cc.start();
    await clock.advance(3000);
    audio.hit();
    cc.stop();
    await flush();
    expect(cc.phase).toBe('stopped');
    expect(s.all()).toHaveLength(1); // im Speicher für Statistik
    expect(s.persistent).toBe(false);
  });

  it('ein durch Schließen nicht beendetes Spiel wird beim nächsten Öffnen gespeichert', async () => {
    await startAndRun();
    audio.hit();
    audio.hit();
    await clock.advance(6000);
    c.tick();
    // Seite wird geschlossen, ohne Stopp
    const s2 = await reopenStore();
    expect(s2.all()).toHaveLength(0);
    const c2 = new GameController(new FakeAudio(clock), s2, clock, wake, drafts);
    await c2.recoverDraft();
    expect(s2.all()).toHaveLength(1);
    expect(s2.all()[0].hits).toBe(2);
    expect(drafts.v).toBeNull();
  });
});


/** Ersatz für die Kamera: Bewegung zu festgelegten Zeitpunkten. */
class FakeCamera implements CameraPort {
  onInterrupted: (() => void) | null = null;
  live = false;
  ensureCalls = 0;
  releases = 0;
  fail: unknown = null;
  facing: CameraFacing | null = null;
  motionAt: number[] = [];
  ensure(facing: CameraFacing) {
    this.ensureCalls++;
    this.facing = facing;
    if (this.fail) return Promise.reject(this.fail);
    this.live = true;
    return Promise.resolve();
  }
  isLive() {
    return this.live;
  }
  peak(t0: number, t1: number) {
    if (!this.live) return null;
    return this.motionAt.some((t) => t >= t0 && t <= t1) ? 30 : 1;
  }
  typical() {
    return this.live ? 1 : null;
  }
  release() {
    this.releases++;
    this.live = false;
  }
}

describe('Kamera-Bestätigung', () => {
  let cam: FakeCamera;
  let cc: GameController;

  beforeEach(() => {
    cam = new FakeCamera();
    cc = new GameController(audio, store, clock, wake, drafts, cam);
  });

  async function run() {
    cc.start();
    await clock.advance(3000);
    expect(cc.phase).toBe('running');
  }

  /** Ton-Kandidat; withMotion = Schwung im Bild zur selben Zeit */
  async function candidate(withMotion: boolean) {
    if (withMotion) cam.motionAt.push(clock.mono() + 80);
    audio.hit();
    await clock.advance(400);
  }

  it('startet die Kamera mit dem Spiel und macht den Ton empfindlicher', async () => {
    await run();
    expect(cam.ensureCalls).toBe(1);
    expect(cc.cameraActive).toBe(true);
    expect(audio.lastBoost).toBe(CAMERA_CANDIDATE_BOOST_DB);
  });

  it('zählt nur Töne mit Bewegung und speichert die Prüfung im Spiel', async () => {
    await run();
    await candidate(true);
    await candidate(false);
    await candidate(true);
    expect(cc.hits).toBe(2);
    cc.stop();
    await flush();
    const g = store.all()[0];
    expect(g.hits).toBe(2);
    expect(g.cameraCheck).toEqual({ candidates: 3, confirmed: 2, rejected: 1, noCamera: 0 });
    expect(cam.live).toBe(false); // Kamera mit Stopp freigegeben
  });

  it('Kandidat kurz vor Stopp verändert den Zähler danach nicht', async () => {
    await run();
    cam.motionAt.push(clock.mono() + 50);
    audio.hit();
    cc.stop();
    await clock.advance(1000);
    expect(store.all()[0].hits).toBe(0);
  });

  it('Kamera verweigert: Spiel läuft sichtbar nur mit Ton, normale Schwelle', async () => {
    cam.fail = Object.assign(new Error('x'), { name: 'NotAllowedError' });
    (globalThis as { window?: unknown }).window = { self: 1, top: 1 };
    await run();
    expect(cc.cameraStatus).toBe('failed');
    expect(cc.cameraNotice?.problem).toBe('denied');
    expect(cc.cameraNotice?.action).toMatch(/nur mit Ton/);
    expect(audio.lastBoost).toBe(0);
    audio.hit();
    expect(cc.hits).toBe(1); // sofort, ohne Kamera-Prüfung
  });

  it('Kamera fällt während des Spiels aus: offene Kandidaten zählen, danach nur Ton', async () => {
    await run();
    audio.hit(); // Kandidat offen
    cam.live = false;
    cam.onInterrupted?.();
    expect(cc.cameraStatus).toBe('failed');
    expect(cc.cameraNotice?.problem).toBe('lost');
    expect(audio.lastBoost).toBe(0);
    await clock.advance(400);
    expect(cc.hits).toBe(1); // „ohne Kamera“ gezählt statt verloren
    audio.hit();
    expect(cc.hits).toBe(2);
    expect(cc.phase).toBe('running');
  });

  it('Schlagtest mit Kamera: verworfene Töne zählen nicht', async () => {
    cc.startTest();
    await clock.advance(3000);
    expect(cc.test?.listening).toBe(true);
    await candidate(true);
    await candidate(true);
    await candidate(false);
    expect(cc.test?.count).toBe(2);
    expect(cc.test?.check.rejected).toBe(1);
    cc.endTest();
    expect(store.all()).toHaveLength(0);
    expect(cam.live).toBe(false);
  });

  it('Kamera-Bestätigung ausgeschaltet: keine Kamera, normale Schwelle', async () => {
    cc.setCameraEnabled(false);
    await run();
    expect(cam.ensureCalls).toBe(0);
    expect(audio.lastBoost).toBe(0);
    audio.hit();
    expect(cc.hits).toBe(1);
  });

  it('Pause und Fortsetzen behalten die Kamera-Statistik', async () => {
    await run();
    await candidate(true);
    cc.handleHidden();
    cc.resume();
    await clock.advance(3000);
    await candidate(false);
    cc.stop();
    await flush();
    expect(store.all()[0].cameraCheck).toEqual({ candidates: 2, confirmed: 1, rejected: 1, noCamera: 0 });
  });
});
