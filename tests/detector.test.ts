import { describe, expect, it } from 'vitest';
import { DetectorCore, configFromSensitivity } from '../src/audio/detectorCore';
import { DetectorHost } from '../src/audio/detectorHost';
import type { FromProcessor } from '../src/audio/protocol';
import { add, mixAt, pock, rng, runBlocks, whiteNoise, wind } from './signals';

function calibrated(sr: number, background: Float32Array, sensitivity = 6): DetectorCore {
  const core = new DetectorCore(sr, configFromSensitivity(sensitivity));
  core.setMode('calibrate');
  const calHits = runBlocks((b) => core.process(b), background);
  expect(calHits).toBe(0);
  core.finishCalibration();
  core.setMode('detect');
  return core;
}

for (const sr of [48000, 44100]) {
  describe(`Impulsdetektor bei ${sr} Hz`, () => {
    const bg = () => whiteNoise(sr, 3, -55, 3);

    it('zählt einen einzelnen Impuls genau einmal', () => {
      const core = calibrated(sr, bg());
      const sig = whiteNoise(sr, 2, -55, 11);
      mixAt(sig, pock(sr, 0.4), 1.0, sr);
      expect(runBlocks((b) => core.process(b), sig)).toBe(1);
    });

    it('zählt zwei ausreichend getrennte Impulse zweimal', () => {
      const core = calibrated(sr, bg());
      const sig = whiteNoise(sr, 2, -55, 12);
      mixAt(sig, pock(sr, 0.4), 0.5, sr);
      mixAt(sig, pock(sr, 0.35), 0.9, sr);
      expect(runBlocks((b) => core.process(b), sig)).toBe(2);
    });

    it('zählt zwei Impulse innerhalb der Sperrzeit (100 ms) nur einmal', () => {
      const core = calibrated(sr, bg());
      const sig = whiteNoise(sr, 1.5, -55, 13);
      mixAt(sig, pock(sr, 0.4), 0.5, sr);
      mixAt(sig, pock(sr, 0.4), 0.6, sr);
      expect(runBlocks((b) => core.process(b), sig)).toBe(1);
    });

    it('zählt bei gleichmäßigem Hintergrundrauschen nicht fortlaufend', () => {
      const core = calibrated(sr, bg());
      expect(runBlocks((b) => core.process(b), whiteNoise(sr, 20, -55, 14))).toBe(0);
    });

    it('zählt einen dauerhaft lauteren Hintergrund höchstens einmal', () => {
      const core = calibrated(sr, bg());
      const loud = whiteNoise(sr, 15, -30, 15); // plötzlich +25 dB, dauerhaft
      expect(runBlocks((b) => core.process(b), loud)).toBeLessThanOrEqual(1);
    });

    it('dämpft tieffrequentes Windrumpeln (ca. −10 dBFS) und erkennt Schläge darüber', () => {
      // ein durchgehendes Signal wie ein echter Mikrofonstrom: 3 s Kalibrierung, 12 s nur Wind, 4 s mit Schlägen
      const all = add(whiteNoise(sr, 19, -55, 21), wind(sr, 19, 0.3, 22));
      mixAt(all, pock(sr, 0.3), 16.0, sr);
      mixAt(all, pock(sr, 0.3), 17.2, sr);
      const cut = (a: number, b: number) => all.subarray(Math.round(a * sr), Math.round(b * sr));
      const core = calibrated(sr, cut(0, 3));
      expect(runBlocks((b) => core.process(b), cut(3, 15))).toBe(0);
      expect(runBlocks((b) => core.process(b), cut(15, 19))).toBe(2);
    });

    it('erkennt einen simulierten Ballwechsel mit 30 Schlägen vollständig', () => {
      const core = calibrated(sr, bg());
      const rand = rng(99);
      const sig = whiteNoise(sr, 45, -55, 31);
      let t = 0.8;
      let n = 0;
      while (n < 30) {
        mixAt(sig, pock(sr, 0.15 + rand() * 0.35, 1400 + rand() * 1200, 3 + rand() * 5), t, sr);
        t += 0.6 + rand() * 0.8;
        n++;
      }
      expect(runBlocks((b) => core.process(b), sig)).toBe(30);
    });

    it('der Empfindlichkeitsregler verändert tatsächlich die Erkennungsschwelle', () => {
      const sigFor = () => {
        const s = whiteNoise(sr, 2, -55, 41);
        mixAt(s, pock(sr, 0.012), 1.0, sr); // leiser Schlag, ca. 18 dB über Hintergrund
        return s;
      };
      const low = calibrated(sr, bg(), 1);
      expect(runBlocks((b) => low.process(b), sigFor())).toBe(0);
      const high = calibrated(sr, bg(), 10);
      expect(runBlocks((b) => high.process(b), sigFor())).toBe(1);
    });

    it('zählt im Leerlauf und während der Kalibrierung nichts', () => {
      const core = new DetectorCore(sr, configFromSensitivity(6));
      const sig = whiteNoise(sr, 2, -55, 51);
      mixAt(sig, pock(sr, 0.5), 0.5, sr);
      mixAt(sig, pock(sr, 0.5), 1.2, sr);
      expect(runBlocks((b) => core.process(b), sig)).toBe(0); // idle
      core.setMode('calibrate');
      expect(runBlocks((b) => core.process(b), sig)).toBe(0);
    });
  });
}

describe('Kalibrierung', () => {
  it('bestimmt den Hintergrund robust trotz einzelner Impulse', () => {
    const sr = 48000;
    const core = new DetectorCore(sr, configFromSensitivity(6));
    const quiet = whiteNoise(sr, 3, -55, 61);
    core.setMode('calibrate');
    runBlocks((b) => core.process(b), quiet);
    const ref = core.finishCalibration().floorDb;

    const withBursts = whiteNoise(sr, 3, -55, 61);
    mixAt(withBursts, pock(sr, 0.6), 0.7, sr);
    mixAt(withBursts, pock(sr, 0.6), 2.0, sr);
    core.setMode('calibrate');
    runBlocks((b) => core.process(b), withBursts);
    const res = core.finishCalibration();
    expect(res.hasSignal).toBe(true);
    expect(Math.abs(res.floorDb - ref)).toBeLessThan(1.5);
  });

  it('meldet „kein Signal“ bei digitaler Stille', () => {
    const core = new DetectorCore(48000, configFromSensitivity(6));
    core.setMode('calibrate');
    runBlocks((b) => core.process(b), new Float32Array(48000 * 3));
    expect(core.finishCalibration().hasSignal).toBe(false);
  });

  it('passt die Framegröße an die Sample-Rate an', () => {
    expect(new DetectorCore(48000, configFromSensitivity(6)).frameSize).toBe(240);
    expect(new DetectorCore(44100, configFromSensitivity(6)).frameSize).toBe(221);
    expect(new DetectorCore(16000, configFromSensitivity(6)).frameSize).toBe(80);
  });
});

describe('DetectorHost (Nachrichtenprotokoll wie im AudioWorklet)', () => {
  it('kalibriert, zählt mit Generation und stoppt sofort bei idle', () => {
    const sr = 48000;
    const msgs: FromProcessor[] = [];
    const host = new DetectorHost(sr, (m) => msgs.push(m));
    host.handle({ type: 'calibrate', durationMs: 3000, token: 7 });
    const cal = whiteNoise(sr, 3.1, -55, 71);
    for (let i = 0; i < cal.length; i += 128) host.process(cal.subarray(i, i + 128));
    const calMsg = msgs.find((m) => m.type === 'calibrated');
    expect(calMsg && calMsg.type === 'calibrated' && calMsg.token).toBe(7);

    host.handle({ type: 'detect', gen: 42 });
    const play = whiteNoise(sr, 2, -55, 72);
    mixAt(play, pock(sr, 0.4), 0.5, sr);
    for (let i = 0; i < play.length; i += 128) host.process(play.subarray(i, i + 128));
    const hits = msgs.filter((m) => m.type === 'hit');
    expect(hits).toEqual([{ type: 'hit', gen: 42 }]);

    host.handle({ type: 'idle' });
    const after = whiteNoise(sr, 2, -55, 73);
    mixAt(after, pock(sr, 0.5), 0.5, sr);
    for (let i = 0; i < after.length; i += 128) host.process(after.subarray(i, i + 128));
    expect(msgs.filter((m) => m.type === 'hit')).toHaveLength(1);
    expect(msgs.some((m) => m.type === 'level')).toBe(true);
  });
});
