// AudioWorklet: kontinuierliche Verarbeitung unabhängig vom UI-Rendering.
// Audio wird nur im Speicher verarbeitet, nie aufgezeichnet oder hörbar ausgegeben.
import { DetectorHost } from './detectorHost';
import type { ToProcessor } from './protocol';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class BeachRallyDetector extends AudioWorkletProcessor {
  private readonly host: DetectorHost;

  constructor() {
    super();
    this.host = new DetectorHost(sampleRate, (msg) => this.port.postMessage(msg));
    this.port.onmessage = (e: MessageEvent<ToProcessor>) => this.host.handle(e.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) this.host.process(channel);
    // Ausgang bleibt stumm: Mikrofon wird nie über den Lautsprecher ausgegeben.
    const out = outputs[0];
    if (out) for (const ch of out) ch.fill(0);
    return true;
  }
}

registerProcessor('beach-rally-detector', BeachRallyDetector);
