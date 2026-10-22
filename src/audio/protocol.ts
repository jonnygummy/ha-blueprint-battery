import type { CalibrationResult, DetectorConfig } from './detectorCore';

/** Nachrichten vom Haupt-Thread an die Audioverarbeitung. */
export type ToProcessor =
  | { type: 'config'; config: DetectorConfig }
  | { type: 'calibrate'; durationMs: number; token: number }
  | { type: 'detect'; gen: number }
  | { type: 'idle' }
  | { type: 'floor'; floorDb: number; spreadDb: number };

/** Nachrichten von der Audioverarbeitung an den Haupt-Thread. */
export type FromProcessor =
  | { type: 'ready'; sampleRate: number; frameSize: number }
  | { type: 'hit'; gen: number; strengthDb: number }
  | { type: 'level'; rawDb: number; filteredDb: number; floorDb: number }
  | { type: 'calibrated'; token: number; result: CalibrationResult };
