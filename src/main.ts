import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import './style.css';
import { AudioEngine } from './audio/audioEngine';
import { GameController, type Clock, type DraftStorage } from './game/controller';
import { ScreenWakeLock } from './game/wakeLock';
import { GameStore } from './storage/gameStore';
import { App } from './ui/app';

const DRAFT_KEY = 'beach-rally-draft';

const clock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

const drafts: DraftStorage = {
  load: () => {
    try {
      return localStorage.getItem(DRAFT_KEY);
    } catch {
      return null;
    }
  },
  save: (v) => {
    try {
      localStorage.setItem(DRAFT_KEY, v);
    } catch {
      /* ignore */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  },
};

async function boot(): Promise<void> {
  const store = new GameStore();
  await store.open();
  const audio = new AudioEngine();
  const wake = new ScreenWakeLock();
  const controller = new GameController(audio, store, clock, wake, drafts);
  const app = new App(controller, store, audio, wake);
  app.mount();
  await controller.recoverDraft();
}

void boot();
