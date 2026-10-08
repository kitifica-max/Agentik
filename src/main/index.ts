import { app, BrowserWindow, dialog, globalShortcut, screen } from 'electron';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { FSWatcher } from 'chokidar';
import { openDb, getState, setState, type Db } from '../db/db.js';
import { Observer } from '../observer/observer.js';
import { readActiveWindow } from '../observer/activeWindow.js';
import { purgeExpired } from '../observer/retention.js';
import { startFileWatcher } from '../observer/fileWatcher.js';
import { loadUserConfig, saveConfig } from './config.js';
import { registerIpc } from './ipc.js';
import { IPC } from '../shared/ipc-channels.js';
import { AiClient } from '../ai/client.js';
import { proposeMemory, approveMemory, rejectMemory, deleteMemory, listMemories } from '../memory/memory.js';
import { SuggestionEngine, type Suggestion } from '../suggestions/engine.js';
import { dailySummary } from '../summary/daily.js';
import { usageTotals, costReport } from '../ai/cost.js';
import { gitToday, resume } from '../git/git.js';
import { scanDisk, formatReport, cleanLast } from '../disk/disk.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { approveFileEdit, approveAllFileEdits, rejectFileEdit, rejectAllFileEdits, listFileEdits, getAuditLog } from '../files/fileTools.js';
import type { CharacterState, Config, MemoryTipo, ObserverStatus } from '../shared/types.js';

// ponytail: busca .env en proyecto (dev) y ~/.agetik.env (producción)
loadEnv();
loadEnv({ path: join(app.getPath('home'), '.agetik.env') });

const CHAR_SIZE = { width: 150, height: 160 };
const BUBBLE_SIZE = { width: 360, height: 480 };
const RETENTION_EVERY_MS = 60 * 60 * 1000;

let character: BrowserWindow | null = null;
let bubble: BrowserWindow | null = null;
let db: Db;
let observer: Observer;
let config: Config;
let ai: AiClient;
let suggestions: SuggestionEngine;
let activeSuggestion: Suggestion | null = null;
let backupDir: string;
let fileWatcher: FSWatcher | null = null;
const SUGGESTION_POLL_MS = 30_000;

function restartFileWatcher(): void {
  fileWatcher?.close();
  fileWatcher = startFileWatcher(config.allowed_folders, (p) => observer.recordFileChange(p));
}

async function handleAddFolder(): Promise<string[]> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'multiSelections'] });
  if (result.canceled || result.filePaths.length === 0) return config.allowed_folders;
  for (const folder of result.filePaths) {
    if (!config.allowed_folders.includes(folder)) {
      config.allowed_folders.push(folder);
    }
  }
  saveConfig(config);
  restartFileWatcher();
  return config.allowed_folders;
}

function handleRemoveFolder(folder: string): string[] {
  config.allowed_folders = config.allowed_folders.filter(f => f !== folder);
  saveConfig(config);
  restartFileWatcher();
  return config.allowed_folders;
}

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

const SUMMARY_RE = /^\s*¿?\s*(resumen(\s+del\s+d[ií]a)?|qu[eé]\s+avanc[eé](\s+hoy)?|mi\s+avance(\s+de\s+hoy)?)\s*[?.!]*\s*$/i;
const RESUME_RE = /^\s*¿?\s*(retoma|retomar|d[oó]nde\s+me\s+qued[eé]|en\s+qu[eé]\s+(estaba|iba))\s*[?.!]*\s*$/i;

async function localSummary(): Promise<string> {
  const base = dailySummary(db, Math.min(24, config.retention_hours));
  const git = await gitToday(workRoots()).catch(() => '');
  return git ? `${base}\n\n${git}` : base;
}

const COST_RE = /^\s*¿?\s*(gasto|consumo|cu[aá]nto\s+(he\s+gastado|llevo(\s+gastado)?|llevamos|cuesta\s+el\s+agente))(\s+(hoy|de\s+hoy|del\s+mes))?\s*[?.!]*\s*$/i;
const CLEAN_RE = /^\s*(limpia|limpiar|limpia todo)\s*[.!?]?\s*$/i;
const DISK_RE = /(espacio|disco)/i;
const DISK_VERB_RE = /(libera|liberar|liberes|revis|limpi|cu[aá]nto|falta|lleno|llen[oa]|ocupa|pesa)/i;

function workRoots(): string[] {
  const h = homedir();
  return [...new Set([...config.allowed_folders, ...['Documents', 'Developer', 'Projects', 'Desktop'].map((d) => join(h, d))])]
    .filter((p) => existsSync(p));
}

// Comandos que se resuelven en la Mac, sin modelo y sin tokens.
async function localCommand(msg: string): Promise<string | null> {
  if (SUMMARY_RE.test(msg)) return localSummary();
  if (RESUME_RE.test(msg)) return resume(workRoots());
  if (COST_RE.test(msg)) return costReport(usageTotals(db));
  if (CLEAN_RE.test(msg)) return cleanLast(db);
  if (/^\s*espacio\s*[.!?]?\s*$/i.test(msg) || (DISK_RE.test(msg) && DISK_VERB_RE.test(msg))) {
    return formatReport(await scanDisk({ roots: workRoots() }));
  }
  return null;
}

async function handleChat(msg: string): Promise<{ reply: string }> {
  setCharacterState('pensando');
  bubble?.webContents.send(IPC.chatThinking, true);

  try {
    const local = await localCommand(msg);
    if (local !== null) return { reply: local };

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

    if (result.opsExecuted > 0) {
      showToastInBubble(`${result.opsExecuted} operaciones ejecutadas`);
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

function showToastInBubble(text: string): void {
  bubble?.webContents.executeJavaScript(
    `(typeof showToast === 'function') && showToast(${JSON.stringify(text)})`,
  ).catch(() => {});
}

function showBubble(): void {
  if (bubble && !bubble.isVisible()) toggleBubble();
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const actions: Record<keyof Config['shortcuts'], () => void> = {
    pause: () => observer.togglePause(),
    toggle_bubble: toggleBubble,
    summary: () => { showBubble(); void localSummary().then((t) => bubble?.webContents.send(IPC.chatReply, t)); },
    new_chat: () => { ai.clearSession(); showBubble(); bubble?.webContents.send(IPC.chatClear); },
  };
  for (const [name, run] of Object.entries(actions)) {
    const accel = config.shortcuts[name as keyof Config['shortcuts']];
    try {
      if (!globalShortcut.register(accel, run)) console.warn(`[agetik] atajo "${accel}" (${name}) ya está en uso`);
    } catch {
      console.warn(`[agetik] atajo inválido "${accel}" (${name})`);
    }
  }
}

function evaluateSuggestions(): void {
  if (!observer.isActive) return;
  const s = suggestions.evaluate();
  if (!s) return;
  activeSuggestion = s;
  setCharacterState('con-sugerencia');
  bubble?.webContents.send(IPC.suggestionShow, s);
}

async function handleSuggestionAccept(id: string): Promise<{ reply: string }> {
  if (!activeSuggestion || activeSuggestion.id !== id) return { reply: '' };
  const text = activeSuggestion.text;
  activeSuggestion = null;
  return handleChat(text);
}

function handleSuggestionDismiss(id: string): void {
  if (!activeSuggestion || activeSuggestion.id !== id) return;
  suggestions.dismiss(activeSuggestion.rule);
  activeSuggestion = null;
  setCharacterState(characterStateFor(observer.status()));
}

app.whenReady().then(() => {
  app.dock?.hide();

  config = loadUserConfig(app.getPath('userData'), join(app.getAppPath(), 'config.json'));
  db = openDb(join(app.getPath('userData'), 'agetik.db'));
  backupDir = join(app.getPath('userData'), 'backups');
  observer = new Observer(db, config, readActiveWindow, pushStatus);
  ai = new AiClient(db, config, backupDir);
  suggestions = new SuggestionEngine(db, config);

  // ponytail: solo empaquetada; en dev registraría el binario de Electron como login item
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.launch_at_login });

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
    suggestionAccept: handleSuggestionAccept,
    suggestionDismiss: handleSuggestionDismiss,
    fileEditList: () => listFileEdits(db),
    fileEditApprove: (id) => approveFileEdit(db, id, backupDir),
    fileEditApproveAll: () => approveAllFileEdits(db, backupDir),
    fileEditReject: (id) => rejectFileEdit(db, id),
    fileEditRejectAll: () => rejectAllFileEdits(db),
    auditLog: () => getAuditLog(db),
    configGetFolders: () => config.allowed_folders,
    configAddFolder: handleAddFolder,
    configRemoveFolder: handleRemoveFolder,
    usageGet: () => usageTotals(db),
  });

  setInterval(() => void observer.tick(), config.observer_poll_ms);
  setInterval(evaluateSuggestions, SUGGESTION_POLL_MS);
  purgeExpired(db, config.retention_hours);
  setInterval(() => purgeExpired(db, config.retention_hours), RETENTION_EVERY_MS);
  fileWatcher = startFileWatcher(config.allowed_folders, (p) => observer.recordFileChange(p));

  registerShortcuts();

  pushStatus(observer.status());
});

app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  db?.close();
});
