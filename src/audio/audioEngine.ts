import workletUrl from './detector.worklet.ts?worker&url';
import { configFromSensitivity, type CalibrationResult } from './detectorCore';
import { DetectorHost } from './detectorHost';
import type { FromProcessor, ToProcessor } from './protocol';
import { CancelledError, MicAccessError, classifyGetUserMediaError, micError, preflight } from './micErrors';

export { CancelledError };

export interface LevelInfo {
  rawDb: number;
  filteredDb: number;
  floorDb: number;
}

export interface MicTechInfo {
  sampleRate: number;
  backend: 'AudioWorklet' | 'ScriptProcessor';
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
}

/** Schnittstelle, über die die Spiellogik mit der Audioverarbeitung spricht. */
export interface AudioPort {
  /** Muss synchron aus einer Nutzeraktion heraus aufgerufen werden. */
  ensure(): Promise<void>;
  isLive(): boolean;
  calibrate(durationMs: number): Promise<CalibrationResult>;
  setFloor(floorDb: number, spreadDb: number): void;
  /** gen = Zählgeneration; null = Erkennung aus. */
  detect(gen: number | null): void;
  setSensitivity(sensitivity: number): void;
  release(): void;
  onHit: ((gen: number) => void) | null;
  onLevel: ((level: LevelInfo) => void) | null;
  onInterrupted: (() => void) | null;
}

type Ctor = typeof AudioContext;

export class AudioEngine implements AudioPort {
  onHit: ((gen: number) => void) | null = null;
  onLevel: ((level: LevelInfo) => void) | null = null;
  onInterrupted: (() => void) | null = null;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private fallbackHost: DetectorHost | null = null;
  private sink: GainNode | null = null;
  private live = false;
  private epoch = 0;
  private startPromise: Promise<void> | null = null;
  private sensitivity = 6;
  private calToken = 0;
  private pendingCal: { token: number; resolve: (r: CalibrationResult) => void; reject: (e: unknown) => void; timer: number } | null = null;
  private watchdog: number | null = null;
  private lastLevelAt = 0;
  private tech: MicTechInfo | null = null;

  getTechInfo(): MicTechInfo | null {
    return this.tech;
  }

  isLive(): boolean {
    return this.live && !!this.ctx && this.ctx.state === 'running' && this.stream?.getAudioTracks()[0]?.readyState === 'live';
  }

  ensure(): Promise<void> {
    if (this.isLive()) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.ctx) this.release(); // halbtoter Zustand: sauber neu aufbauen

    const pre = preflight();
    if (pre) return Promise.reject(new MicAccessError(pre));

    const Ctx: Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: Ctor }).webkitAudioContext;
    // AudioContext synchron innerhalb der Nutzeraktion erzeugen und fortsetzen (iOS).
    let ctx: AudioContext;
    try {
      ctx = new Ctx({ latencyHint: 'interactive' });
    } catch {
      return Promise.reject(new MicAccessError(micError('unsupported')));
    }
    void ctx.resume().catch(() => undefined);
    this.ctx = ctx;
    const myEpoch = ++this.epoch;

    this.startPromise = this.setup(ctx, myEpoch).finally(() => {
      if (this.epoch === myEpoch) this.startPromise = null;
    });
    return this.startPromise;
  }

  private async setup(ctx: AudioContext, myEpoch: number): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await this.getStream();
    } catch (err) {
      if (this.epoch === myEpoch) this.release();
      throw new MicAccessError(classifyGetUserMediaError(err));
    }
    if (this.epoch !== myEpoch) {
      stream.getTracks().forEach((t) => t.stop());
      throw new CancelledError();
    }
    this.stream = stream;

    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      /* unten geprüft */
    }

    const source = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain();
    sink.gain.value = 0; // stumm: Mikrofon nie hörbar ausgeben
    sink.connect(ctx.destination);
    this.source = source;
    this.sink = sink;

    let backend: MicTechInfo['backend'] = 'AudioWorklet';
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('no worklet');
      await ctx.audioWorklet.addModule(workletUrl);
      if (this.epoch !== myEpoch) throw new CancelledError();
      const node = new AudioWorkletNode(ctx, 'beach-rally-detector', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      node.port.onmessage = (e: MessageEvent<FromProcessor>) => this.receive(e.data, myEpoch);
      source.connect(node);
      node.connect(sink);
      this.node = node;
    } catch (err) {
      if (err instanceof CancelledError || this.epoch !== myEpoch) {
        throw new CancelledError();
      }
      // Fallback für ältere Browser: gleiche Erkennung im Haupt-Thread.
      backend = 'ScriptProcessor';
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      const host = new DetectorHost(ctx.sampleRate, (msg) => this.receive(msg, myEpoch));
      sp.onaudioprocess = (e) => {
        host.process(e.inputBuffer.getChannelData(0));
        e.outputBuffer.getChannelData(0).fill(0);
      };
      source.connect(sp);
      sp.connect(sink);
      this.scriptNode = sp;
      this.fallbackHost = host;
    }

    if (this.epoch !== myEpoch) throw new CancelledError();
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    if (ctx.state !== 'running') {
      this.release();
      throw new MicAccessError({
        ...micError('interrupted'),
        action: 'Mikrofon ist freigegeben. Tippe noch einmal auf den Button, um zu starten.',
      });
    }

    const track = stream.getAudioTracks()[0];
    const settings = (track?.getSettings?.() ?? {}) as MediaTrackSettings;
    this.tech = {
      sampleRate: ctx.sampleRate,
      backend,
      echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null,
      noiseSuppression: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
      autoGainControl: typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : null,
    };

    track?.addEventListener('ended', this.handleInterruption);
    track?.addEventListener('mute', this.handleMute);
    ctx.addEventListener('statechange', this.handleStateChange);

    this.live = true;
    this.post({ type: 'config', config: configFromSensitivity(this.sensitivity) });
    this.lastLevelAt = performance.now();
    this.watchdog = window.setInterval(() => {
      if (this.live && performance.now() - this.lastLevelAt > 2500) this.handleInterruption();
    }, 1000);
  }

  private async getStream(): Promise<MediaStream> {
    const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
    const audio: MediaTrackConstraints = { channelCount: { ideal: 1 } };
    // Bearbeitung durch den Browser möglichst abschalten (optional, nie erzwungen).
    if (supported.echoCancellation) audio.echoCancellation = false;
    if (supported.noiseSuppression) audio.noiseSuppression = false;
    if (supported.autoGainControl) audio.autoGainControl = false;
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'OverconstrainedError' || name === 'TypeError' || name === 'ConstraintNotSatisfiedError') {
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      throw err;
    }
  }

  private readonly handleStateChange = (): void => {
    if (!this.live || !this.ctx) return;
    if (this.ctx.state !== 'running') this.handleInterruption();
  };

  private readonly handleMute = (): void => {
    // iOS schaltet Spuren bei Unterbrechungen stumm (z. B. Anruf, Siri).
    // Kurzes Stummschalten ignorieren, nur anhaltendes als Unterbrechung werten.
    const track = this.stream?.getAudioTracks()[0];
    const myEpoch = this.epoch;
    window.setTimeout(() => {
      if (this.epoch === myEpoch && track?.muted) this.handleInterruption();
    }, 800);
  };

  private readonly handleInterruption = (): void => {
    if (!this.live) return;
    this.live = false;
    this.onInterrupted?.();
  };

  private receive(msg: FromProcessor, fromEpoch: number): void {
    if (fromEpoch !== this.epoch) return; // verspätete Nachrichten alter Streams verwerfen
    switch (msg.type) {
      case 'hit':
        this.onHit?.(msg.gen);
        break;
      case 'level':
        this.lastLevelAt = performance.now();
        this.onLevel?.(msg);
        break;
      case 'calibrated':
        if (this.pendingCal && this.pendingCal.token === msg.token) {
          const p = this.pendingCal;
          this.pendingCal = null;
          window.clearTimeout(p.timer);
          if (msg.result.hasSignal) p.resolve(msg.result);
          else p.reject(new MicAccessError(micError('nosignal')));
        }
        break;
      case 'ready':
        break;
    }
  }

  private post(msg: ToProcessor): void {
    if (this.node) this.node.port.postMessage(msg);
    else if (this.fallbackHost) this.fallbackHost.handle(msg);
  }

  calibrate(durationMs: number): Promise<CalibrationResult> {
    this.cancelCalibration(new CancelledError());
    const token = ++this.calToken;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pendingCal?.token === token) {
          this.pendingCal = null;
          reject(new MicAccessError(micError('nosignal')));
        }
      }, durationMs + 3000);
      this.pendingCal = { token, resolve, reject, timer };
      this.post({ type: 'calibrate', durationMs, token });
    });
  }

  private cancelCalibration(reason: unknown): void {
    if (!this.pendingCal) return;
    const p = this.pendingCal;
    this.pendingCal = null;
    window.clearTimeout(p.timer);
    p.reject(reason);
  }

  setFloor(floorDb: number, spreadDb: number): void {
    this.post({ type: 'floor', floorDb, spreadDb });
  }

  detect(gen: number | null): void {
    this.post(gen === null ? { type: 'idle' } : { type: 'detect', gen });
  }

  setSensitivity(sensitivity: number): void {
    this.sensitivity = sensitivity;
    this.post({ type: 'config', config: configFromSensitivity(sensitivity) });
  }

  release(): void {
    this.epoch++;
    this.live = false;
    this.startPromise = null;
    this.cancelCalibration(new CancelledError());
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.node) {
      this.node.port.onmessage = null;
      try {
        this.node.port.postMessage({ type: 'idle' } satisfies ToProcessor);
      } catch {
        /* ignore */
      }
    }
    if (this.scriptNode) this.scriptNode.onaudioprocess = null;
    for (const n of [this.source, this.node, this.scriptNode, this.sink]) {
      try {
        n?.disconnect();
      } catch {
        /* ignore */
      }
    }
    const track = this.stream?.getAudioTracks()[0];
    track?.removeEventListener('ended', this.handleInterruption);
    track?.removeEventListener('mute', this.handleMute);
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx) {
      this.ctx.removeEventListener('statechange', this.handleStateChange);
      void this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.scriptNode = null;
    this.fallbackHost = null;
    this.sink = null;
  }
}
