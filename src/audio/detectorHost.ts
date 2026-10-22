import { DetectorCore, configFromSensitivity, SENSITIVITY_DEFAULT } from './detectorCore';
import type { FromProcessor, ToProcessor } from './protocol';

const LEVEL_INTERVAL_SEC = 0.06;

/**
 * Verbindet den DetectorCore mit dem Nachrichtenprotokoll.
 * Wird identisch im AudioWorklet und im ScriptProcessor-Fallback verwendet.
 */
export class DetectorHost {
  private readonly core: DetectorCore;
  private readonly post: (msg: FromProcessor) => void;
  private detectGen: number | null = null;
  private calibration: { token: number; samplesLeft: number } | null = null;
  private samplesSinceLevel = 0;
  private readonly levelSamples: number;

  constructor(sampleRate: number, post: (msg: FromProcessor) => void) {
    this.core = new DetectorCore(sampleRate, configFromSensitivity(SENSITIVITY_DEFAULT));
    this.post = post;
    this.levelSamples = Math.round(sampleRate * LEVEL_INTERVAL_SEC);
    post({ type: 'ready', sampleRate, frameSize: this.core.frameSize });
  }

  handle(msg: ToProcessor): void {
    switch (msg.type) {
      case 'config':
        this.core.setConfig(msg.config);
        break;
      case 'calibrate':
        this.detectGen = null;
        this.calibration = { token: msg.token, samplesLeft: Math.round((msg.durationMs / 1000) * this.core.sampleRate) };
        this.core.setMode('calibrate');
        break;
      case 'detect':
        this.calibration = null;
        this.detectGen = msg.gen;
        this.core.setMode('detect');
        break;
      case 'idle':
        this.calibration = null;
        this.detectGen = null;
        this.core.setMode('idle');
        break;
      case 'floor':
        this.core.setFloor(msg.floorDb, msg.spreadDb);
        break;
    }
  }

  process(samples: Float32Array): void {
    const hits = this.core.process(samples);
    if (hits > 0 && this.detectGen !== null) {
      for (let i = 0; i < hits; i++) this.post({ type: 'hit', gen: this.detectGen, strengthDb: this.core.lastHitMarginDb });
    }
    if (this.calibration) {
      this.calibration.samplesLeft -= samples.length;
      if (this.calibration.samplesLeft <= 0) {
        const token = this.calibration.token;
        this.calibration = null;
        this.post({ type: 'calibrated', token, result: this.core.finishCalibration() });
      }
    }
    this.samplesSinceLevel += samples.length;
    if (this.samplesSinceLevel >= this.levelSamples) {
      this.samplesSinceLevel = 0;
      const lvl = this.core.takeLevel();
      this.post({ type: 'level', rawDb: lvl.rawDb, filteredDb: lvl.filteredDb, floorDb: lvl.floorDb });
    }
  }
}
