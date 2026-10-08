import { app, BrowserWindow, globalShortcut, screen } from 'electron';
import { join } from 'node:path';
import { openDb, getState, setState, type Db } from '../db/db';
import { Observer } from '../observer/observer';
import { readActiveWindow } from '../observer/activeWindow';
import { purgeExpired } from '../observer/retention';
import { startFileWatcher } from '../observer/fileWatcher';
import { loadConfig } from './config';
import { registerIpc } from './ipc';
import { IPC } from '../shared/ipc-channels';
import type { CharacterState, Config, ObserverStatus } from '../shared/types';

const CHAR_SIZE = { width: 150, height: 160 };
const BUBBLE_SIZE = { width: 300, height: 240 };
const RETENTION_EVERY_MS = 60 * 60 * 1000;

let character: BrowserWindow | null = null;
let bubble: BrowserWindow | null = null;
let db: Db;
let observer: Observer;
let config: Config;

function savedPosition(): { x: number; y: number } {
  const raw = getState(db, 'window_position');
  if (raw) {
    try {
      return JSON.parse(raw) as { x: number; y: number };
    } catch {
      // Valor corrupto: cae al default.
    }
  }
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - CHAR_SIZE.width - 16,
    y: workArea.y + workArea.height - CHAR_SIZE.height - 16,
  };
}

function characterStateFor(s: ObserverStatus): CharacterState {
  if (!s.enabled) return 'reposo';
  if (s.paused) return 'pausado';
  return 'observando';
}

function pushStatus(s: ObserverStatus): void {
  const observing = s.enabled && !s.paused;
  character?.webContents.send(IPC.characterState, { state: characterStateFor(s), observing });
  bubble?.webContents.send(IPC.observerChanged, s);
}

function positionBubble(): void {
  if (!character || !bubble) return;
  const [cx, cy] = character.getPosition();
  const { workArea } = screen.getDisplayNearestPoint({ x: cx, y: cy });
  let x = cx + CHAR_SIZE.width - BUBBLE_SIZE.width;
  let y = cy - BUBBLE_SIZE.height - 8;
  if (y < workArea.y) y = cy + CHAR_SIZE.height + 8;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - BUBBLE_SIZE.width));
  bubble.setPosition(Math.round(x), Math.round(y));
}

function createWindows(): void {
  const pos = savedPosition();
  character = new BrowserWindow({
    ...CHAR_SIZE,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  character.setAlwaysOnTop(true, 'floating');
  character.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  character.loadFile(join(__dirname, '../renderer/character.html'));

  bubble = new BrowserWindow({
    ...BUBBLE_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  bubble.setAlwaysOnTop(true, 'floating');
  bubble.loadFile(join(__dirname, '../renderer/bubble.html'));
  bubble.on('blur', () => bubble?.hide());
}

function toggleBubble(): void {
  if (!bubble) return;
  if (bubble.isVisible()) {
    bubble.hide();
    return;
  }
  positionBubble();
  bubble.show();
  bubble.focus();
}

app.whenReady().then(() => {
  // Sin icono en el Dock ni en Cmd+Tab.
  app.dock?.hide();

  config = loadConfig(join(app.getAppPath(), 'config.json'));
  db = openDb(join(app.getPath('userData'), 'agetik.db'));
  observer = new Observer(db, config, readActiveWindow, pushStatus);

  createWindows();

  registerIpc({
    getStatus: () => observer.status(),
    setEnabled: (on) => observer.setEnabled(on),
    togglePause: () => observer.togglePause(),
    toggleBubble,
    moveBy: (dx, dy) => {
      if (!character) return;
      const [x, y] = character.getPosition();
      character.setPosition(Math.round(x + dx), Math.round(y + dy));
    },
    dragEnd: () => {
      if (!character) return;
      const [x, y] = character.getPosition();
      setState(db, 'window_position', JSON.stringify({ x, y }));
    },
    quit: () => app.quit(),
  });

  // Ticks del observador y purga de retención.
  setInterval(() => void observer.tick(), config.observer_poll_ms);
  purgeExpired(db, config.retention_hours);
  setInterval(() => purgeExpired(db, config.retention_hours), RETENTION_EVERY_MS);

  // Archivos: solo si hay carpetas autorizadas (lista vacía por defecto).
  startFileWatcher(config.allowed_folders, (p) => observer.recordFileChange(p));

  // Pausa global con Cmd+Shift+P.
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    observer.togglePause();
  });

  pushStatus(observer.status());
});

app.on('window-all-closed', () => {
  // La app vive sin ventanas (solo personaje).
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  db?.close();
});
