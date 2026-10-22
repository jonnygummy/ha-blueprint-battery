/** Dauerhafte Speicherung aller abgeschlossenen Spiele in IndexedDB. */

export interface GameRecord {
  id: string;
  /** Fortlaufende Spielnummer (1, 2, 3 …). */
  number: number;
  /** Tatsächlicher Beginn der Zählung (ms seit 1970, UTC). */
  startTime: number;
  /** Ende des Spiels (ms seit 1970, UTC). */
  endTime: number;
  /** Aktive Spieldauer ohne Pausen (ms). */
  activeMs: number;
  /** Endgültige Schlagzahl. */
  hits: number;
  /** Nur bei Kamera-Bestätigung: Ton-Kandidaten und Entscheidungen. */
  cameraCheck?: { candidates: number; confirmed: number; rejected: number; noCamera: number };
}

const DB_NAME = 'beach-rally';
const DB_VERSION = 1;
const STORE = 'games';

export interface GameStoreOptions {
  indexedDB?: IDBFactory;
}

/**
 * Hält alle Spiele zusätzlich im Speicher, damit Statistiken auch bei
 * Speicherfehlern weiter funktionieren. `persistent` zeigt ehrlich an,
 * ob der Verlauf aktuell dauerhaft gesichert wird.
 */
export class GameStore {
  private db: IDBDatabase | null = null;
  private readonly games = new Map<string, GameRecord>();
  private readonly idb: IDBFactory | undefined;
  persistent = false;
  lastError: string | null = null;

  constructor(opts: GameStoreOptions = {}) {
    this.idb = opts.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  }

  async open(): Promise<void> {
    if (!this.idb) {
      this.fail('IndexedDB ist in diesem Browser nicht verfügbar.');
      return;
    }
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.idb!.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: 'id' });
            store.createIndex('startTime', 'startTime');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      });
      this.db.onversionchange = () => this.db?.close();
      const all = await this.tx<GameRecord[]>('readonly', (s) => s.getAll());
      for (const g of all) this.games.set(g.id, g);
      this.persistent = true;
      this.lastError = null;
    } catch {
      this.fail('Der Verlauf konnte nicht geöffnet werden.');
    }
  }

  private fail(msg: string): void {
    this.persistent = false;
    this.lastError = msg;
  }

  private tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.db) {
        reject(new Error('no db'));
        return;
      }
      const t = this.db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result as T);
      t.onerror = () => reject(t.error ?? req.error);
      t.onabort = () => reject(t.error ?? new Error('abort'));
    });
  }

  /** Alle Spiele, chronologisch nach Startzeit. */
  all(): GameRecord[] {
    return [...this.games.values()].sort((a, b) => a.startTime - b.startTime || a.number - b.number);
  }

  get(id: string): GameRecord | undefined {
    return this.games.get(id);
  }

  nextNumber(): number {
    let max = 0;
    for (const g of this.games.values()) if (g.number > max) max = g.number;
    return max + 1;
  }

  /**
   * Speichert oder aktualisiert ein Spiel (gleiche ID = gleicher Datensatz).
   * Gibt true nur zurück, wenn tatsächlich dauerhaft gespeichert wurde.
   */
  async put(record: GameRecord): Promise<boolean> {
    this.games.set(record.id, { ...record });
    if (!this.db) {
      this.fail(this.lastError ?? 'Der Verlauf wird nicht dauerhaft gesichert.');
      return false;
    }
    try {
      await this.tx('readwrite', (s) => s.put({ ...record }));
      this.persistent = true;
      this.lastError = null;
      return true;
    } catch {
      this.fail('Das letzte Spiel konnte nicht dauerhaft gespeichert werden.');
      return false;
    }
  }

  /** Nur für isolierte Tests. */
  close(): void {
    this.db?.close();
    this.db = null;
  }
}
