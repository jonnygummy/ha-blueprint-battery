/** Verständliche Fehlermeldungen mit konkreter nächster Aktion statt Fehlercodes. */

export type MicProblem =
  | 'insecure'
  | 'unsupported'
  | 'embedded'
  | 'denied'
  | 'notfound'
  | 'busy'
  | 'nosignal'
  | 'interrupted'
  | 'unknown';

export interface MicError {
  problem: MicProblem;
  title: string;
  action: string;
}

export class MicAccessError extends Error {
  readonly info: MicError;
  constructor(info: MicError) {
    super(info.title);
    this.info = info;
  }
}

/** Ein Vorgang wurde durch eine neuere Aktion abgelöst (kein Fehler für Nutzer). */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
}

const MESSAGES: Record<MicProblem, () => MicError> = {
  insecure: () => ({
    problem: 'insecure',
    title: 'Diese Adresse ist nicht sicher.',
    action: 'Mikrofon geht nur über https://. Öffne die App über den https-Link.',
  }),
  unsupported: () => ({
    problem: 'unsupported',
    title: 'Hier ist kein Mikrofonzugriff möglich.',
    action: isEmbedded()
      ? 'Die Vorschau lässt kein Mikrofon zu. Öffne den Link direkt in Safari oder Chrome.'
      : 'Öffne die App in einem aktuellen Safari (iPhone) oder Chrome (Android).',
  }),
  embedded: () => ({
    problem: 'embedded',
    title: 'Die Vorschau blockiert das Mikrofon.',
    action: 'Öffne den Link direkt in Safari oder Chrome und tippe dort auf „Spiel starten“.',
  }),
  denied: () => ({
    problem: 'denied',
    title: 'Mikrofon ist nicht erlaubt.',
    action: isIOS()
      ? 'In Safari links in der Adressleiste auf „aA“ tippen → Website-Einstellungen → Mikrofon → Erlauben. Dann Seite neu laden.'
      : 'In Chrome auf das Symbol links neben der Adresse tippen → Berechtigungen → Mikrofon erlauben. Dann Seite neu laden.',
  }),
  notfound: () => ({
    problem: 'notfound',
    title: 'Kein Mikrofon gefunden.',
    action: 'Prüfe, ob ein Headset oder Bluetooth-Gerät das Mikrofon belegt, und versuche es erneut.',
  }),
  busy: () => ({
    problem: 'busy',
    title: 'Das Mikrofon wird gerade anderweitig genutzt.',
    action: 'Beende Anruf, Sprachmemo oder Videoaufnahme und tippe erneut auf „Spiel starten“.',
  }),
  nosignal: () => ({
    problem: 'nosignal',
    title: 'Das Mikrofon liefert kein Signal.',
    action: 'Mikrofonöffnung freilegen, Seite neu laden und erneut starten.',
  }),
  interrupted: () => ({
    problem: 'interrupted',
    title: 'Die Audioverarbeitung wurde unterbrochen.',
    action: 'Tippe auf „Fortsetzen“, um das Mikrofon wieder zu aktivieren.',
  }),
  unknown: () => ({
    problem: 'unknown',
    title: 'Mikrofon konnte nicht gestartet werden.',
    action: 'Seite neu laden und erneut versuchen. Hilft das nicht: Browser neu öffnen.',
  }),
};

export function micError(problem: MicProblem): MicError {
  return MESSAGES[problem]();
}

/** Prüft benötigte Browserfähigkeiten vor dem Zugriff. */
export function preflight(): MicError | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return micError('insecure');
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return micError('unsupported');
  }
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return micError('unsupported');
  return null;
}

/** Ordnet einen getUserMedia-Fehler einer verständlichen Meldung zu. */
export function classifyGetUserMediaError(err: unknown): MicError {
  if (err instanceof MicAccessError) return err.info;
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return micError(isEmbedded() ? 'embedded' : 'denied');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return micError('notfound');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return micError('busy');
    default:
      return micError('unknown');
  }
}
