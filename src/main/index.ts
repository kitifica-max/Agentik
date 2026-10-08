import { app, BrowserWindow, globalShortcut, screen } from 'electron';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { openDb, getState, setState, type Db } from '../db/db.js';
import { Observer } from '../observer/observer.js';
import { readActiveWindow } from '../observer/activeWindow.js';
import { purgeExpired } from '../observer/retention.js';
import { startFileWatcher } from '../observer/fileWatcher.js';
import { loadConfig } from './config.js';
import { registerIpc } from './ipc.js';
import { IPC } from '../shared/ipc-channels.js';
import { AiClient } from '../ai/client.js';
import { proposeMemory, approveMemory, rejectMemory, deleteMemory, listMemories } from '../memory/memory.js';
import type { CharacterState, Config, MemoryTipo, ObserverStatus } from '../shared/types.js';

loadEnv();

const CHAR_SIZE = { width: 150, height: 160 };
const BUBBLE_SIZE = { width: 360, height: 480 };
const RETENTION_EVERY_MS = 60 * 60 * 1000;

let character: BrowserWindow | null = null;
let bubble: BrowserWindow | null = null;
let db: Db;
let observer: Observer;
let config: Config;
let ai: AiClient;

function savedPosition(): { x: number; y: number } {
  const raw = getState(db, 'window_position');
  if (raw) {
    try {
      return JSON.parse(raw) as { x: number; y: number };
    } catch { /* corrupto */ }
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

function setCharacterState(state: CharacterState): void {
  const observing = observer.status().enabled && !observer.status().paused;
  character?.webContents.send(IPC.characterState, { state, observing });
}

function pushStatus(s: ObserverStatus): void {
  setCharacterState(characterStateFor(s));
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

const VALID_TIPOS: MemoryTipo[] = ['preferencia', 'proyecto', 'decisión', 'contexto'];

async function handleChat(msg: string): Promise<{ reply: string }> {
  setCharacterState('pensando');
  bubble?.webContents.send(IPC.chatThinking, true);

  try {
    const result = await ai.chat(msg);

    if (result.proposedMemory) {
      const tipo = VALID_TIPOS.includes(result.proposedMemory.tipo as MemoryTipo)
        ? result.proposedMemory.tipo as MemoryTipo
        : 'contexto';
      const mem = proposeMemory(db, result.proposedMemory.contenido, tipo, 'chat');
      if (mem) {
        bubble?.webContents.send(IPC.memoryProposed, mem);
      }
    }

    return { reply: result.reply };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return { reply: `Error: ${message}` };
  } finally {
    setCharacterState(characterStateFor(observer.status()));
    bubble?.webContents.send(IPC.chatThinking, false);
  }
}

app.whenReady().then(() => {
  app.dock?.hide();

  config = loadConfig(join(app.getAppPath(), 'config.json'));
  db = openDb(join(app.getPath('userData'), 'agetik.db'));
  observer = new Observer(db, config, readActiveWindow, pushStatus);
  ai = new AiClient(db, config);

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
    chatSend: handleChat,
    memoryList: () => listMemories(db),
    memoryApprove: (id) => approveMemory(db, id),
    memoryReject: (id) => rejectMemory(db, id),
    memoryDelete: (id) => deleteMemory(db, id),
  });

  setInterval(() => void observer.tick(), config.observer_poll_ms);
  purgeExpired(db, config.retention_hours);
  setInterval(() => purgeExpired(db, config.retention_hours), RETENTION_EVERY_MS);
  startFileWatcher(config.allowed_folders, (p) => observer.recordFileChange(p));

  globalShortcut.register('CommandOrControl+Shift+P', () => {
    observer.togglePause();
  });

  pushStatus(observer.status());
});

app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  db?.close();
});
