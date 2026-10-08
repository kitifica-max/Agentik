import { app, BrowserWindow, dialog, globalShortcut, Notification, safeStorage, screen } from 'electron';
import { join } from 'node:path';
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
import { createProvider, listOllamaModels } from '../ai/providers.js';
import { SecretStore } from './secrets.js';
import { notificationBody, shouldNotify } from './notify.js';
import { learn, MIN_HABIT_DAYS } from '../memory/insights.js';
import { abortable } from '../chat/abort.js';
import { saveExchange, loadHistory, modelContext, clearHistory, type ChatKind } from '../chat/history.js';
import { proposeMemory, approveMemory, rejectMemory, deleteMemory, listMemories } from '../memory/memory.js';
import { SuggestionEngine, type Suggestion } from '../suggestions/engine.js';
import { dailySummary } from '../summary/daily.js';
import { usageTotals, costReport } from '../ai/cost.js';
import { gitToday, resume } from '../git/git.js';
import { scanDisk, formatReport, cleanLast } from '../disk/disk.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { approveFileEdit, approveAllFileEdits, rejectFileEdit, rejectAllFileEdits, listFileEdits, getAuditLog } from '../files/fileTools.js';
import type { CharacterState, Config, Memory, MemoryTipo, ModelProfile, ObserverStatus } from '../shared/types.js';

// Las API keys ya no se leen de archivos .env: se configuran en la pestaña Modelo y se guardan cifradas.

// Los datos viven en la carpeta histórica "agetik": cambiarla perdería DB, config y recuerdos.
app.setPath('userData', join(app.getPath('appData'), 'agetik'));

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
let secrets: SecretStore;
let pendingReply = false; // hay una respuesta sin leer: el personaje salta hasta que abras el chat

// ── Modelos: perfiles en config.json, claves cifradas aparte ──────────────────────────────
function activeProfile(): ModelProfile | undefined {
  return config.models.find((m) => m.id === config.active_model);
}

function keyFor(p: ModelProfile): string | undefined {
  return secrets.get(p.id) ?? undefined;
}

function modelsState(): { active: string; profiles: Array<ModelProfile & { hasKey: boolean }> } {
  return { active: config.active_model, profiles: config.models.map((m) => ({ ...m, hasKey: secrets.has(m.id) })) };
}

function uniqueModelId(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'modelo';
  let id = base;
  for (let n = 2; config.models.some((m) => m.id === id); n++) id = `${base}-${n}`;
  return id;
}

// ── Ajustes (avatar, avisos, sonido) ───────────────────────────────────────────────────────
function settingsState(): { avatar: Config['avatar']; notifications: boolean; sounds: boolean } {
  return { avatar: config.avatar, notifications: config.notifications, sounds: config.sounds };
}

function handleSettingsSet(p: Partial<ReturnType<typeof settingsState>>): unknown {
  const avatarChanged = p.avatar !== undefined && p.avatar !== config.avatar;
  if (p.avatar !== undefined) config.avatar = p.avatar;
  if (p.notifications !== undefined) config.notifications = p.notifications;
  if (p.sounds !== undefined) config.sounds = p.sounds;
  saveConfig(config);
  if (avatarChanged) character?.webContents.send(IPC.avatarChanged, config.avatar); // cambia sin reiniciar
  return settingsState();
}

function handleModelsSave(p: Omit<ModelProfile, 'id'> & { id?: string; api_key?: string }): unknown {
  const { api_key, ...rest } = p;
  const id = rest.id ?? uniqueModelId(rest.label);
  const profile: ModelProfile = { ...rest, id };
  try {
    if (api_key?.trim()) secrets.set(id, api_key);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'No pude guardar la clave' };
  }
  const i = config.models.findIndex((m) => m.id === id);
  if (i >= 0) config.models[i] = profile;
  else config.models.push(profile);
  saveConfig(config);
  return modelsState();
}

function handleModelsDelete(id: string): unknown {
  if (!config.models.some((m) => m.id === id)) return { error: 'Ese modelo no existe' };
  config.models = config.models.filter((m) => m.id !== id);
  secrets.delete(id);
  if (config.active_model === id) config.active_model = config.models[0]?.id ?? '';
  saveConfig(config);
  return modelsState();
}

function handleModelsSetActive(id: string): unknown {
  if (!config.models.some((m) => m.id === id)) return { error: 'Ese modelo no existe' };
  config.active_model = id;
  saveConfig(config);
  return modelsState();
}

async function handleModelsDetect(baseUrl?: string): Promise<unknown> {
  const url = baseUrl ?? 'http://localhost:11434';
  try {
    return { models: await listOllamaModels(url) };
  } catch {
    return { error: `No pude conectar con Ollama en ${url}. ¿Está abierto?` };
  }
}
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
  if (pendingReply) return 'pendiente';
  if (!s.enabled) return 'reposo';
  if (s.paused) return 'pausado';
  return 'observando';
}

function setCharacterState(state: CharacterState): void {
  const observing = observer.status().enabled && !observer.status().paused;
  character?.webContents.send(IPC.characterState, { state, observing, sound: config.sounds });
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
  bubble.on('show', clearPending); // al abrir el chat termina el aviso
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
const LEARN_RE = /^\s*¿?\s*(aprende(\s+de\s+mis\s+(proyectos|h[aá]bitos))?|actualiza\s+(mi\s+)?memoria|qu[eé]\s+has\s+aprendido(\s+de\s+m[ií])?)\s*[?.!]*\s*$/i;
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
  if (LEARN_RE.test(msg)) return learnReply();
  if (CLEAN_RE.test(msg)) return cleanLast(db);
  if (/^\s*espacio\s*[.!?]?\s*$/i.test(msg) || (DISK_RE.test(msg) && DISK_VERB_RE.test(msg))) {
    return formatReport(await scanDisk({ roots: workRoots() }));
  }
  return null;
}

// Una sola tarea a la vez: "Detener" la corta. historyEpoch invalida el guardado de lo que estaba en curso
// si en medio se borró el historial (así no reaparece nada de lo borrado).
let chatAbort: AbortController | null = null;
let historyEpoch = 0;

function stopChat(): boolean {
  const running = chatAbort !== null;
  chatAbort?.abort();
  return running;
}

/** Borra el historial por completo (y corta lo que esté en curso). */
function wipeChat(): number {
  stopChat();
  historyEpoch++;
  ai.clearSession();
  return clearHistory(db);
}

async function handleChat(msg: string, opts: { asAssistant?: boolean } = {}): Promise<{ reply: string; stopped?: boolean }> {
  let flash: CharacterState | null = null; // reacción breve del personaje al terminar
  let notice: { title: string; body: string } | null = null; // aviso nativo si no estás mirando la burbuja
  let record: { reply: string; kind: ChatKind } | null = null; // lo que queda en el historial
  const epoch = historyEpoch;
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  chatAbort = ctrl;
  setCharacterState('pensando');
  bubble?.webContents.send(IPC.chatThinking, true);

  try {
    let local: string | null;
    try {
      // "limpia" borra archivos: no se deja a medias con un Detener que solo aparenta parar
      local = CLEAN_RE.test(msg) ? await localCommand(msg) : await abortable(localCommand(msg), signal);
    } catch (e) {
      if (signal.aborted) { record = { reply: 'Detenido.', kind: 'stopped' }; return { reply: 'Detenido.', stopped: true }; }
      throw e;
    }
    if (local !== null) { record = { reply: local, kind: 'local' }; notice = { title: 'Agentik', body: local }; return { reply: local }; }

    const result = await ai.chat(msg, signal);

    if (result.stopped) {
      record = { reply: result.reply, kind: 'stopped' };
      return { reply: result.reply, stopped: true }; // sin aviso ni reacción: tú lo pediste
    }

    if (result.proposedMemory) {
      const tipo = VALID_TIPOS.includes(result.proposedMemory.tipo as MemoryTipo)
        ? result.proposedMemory.tipo as MemoryTipo
        : 'contexto';
      const mem = proposeMemory(db, result.proposedMemory.contenido, tipo, 'chat');
      if (mem) {
        bubble?.webContents.send(IPC.memoryProposed, mem);
      }
    }

    if (result.opsExecuted > 0) flash = 'exito';
    notice = { title: result.opsExecuted > 0 ? 'Agentik: tarea lista' : 'Agentik', body: result.reply };

    if (result.opsExecuted > 0) {
      showToastInBubble(`${result.opsExecuted} operaciones ejecutadas`);
    }

    record = { reply: result.reply, kind: 'ai' };
    return { reply: result.reply };
  } catch (err: unknown) {
    flash = 'confuso';
    const message = err instanceof Error ? err.message : 'Error desconocido';
    notice = { title: 'Agentik: algo falló', body: message };
    record = { reply: `Error: ${message}`, kind: 'error' };
    return { reply: `Error: ${message}` };
  } finally {
    chatAbort = null;
    if (record && epoch === historyEpoch) {
      // una sugerencia aceptada se ve como mensaje del asistente, no como algo que escribiste
      if (opts.asAssistant) { saveExchange(db, null, msg, record.kind); saveExchange(db, null, record.reply, record.kind); }
      else saveExchange(db, msg, record.reply, record.kind);
    }
    // Si la respuesta llega y no estás mirando la burbuja: queda pendiente (pop + salto) hasta que la abras
    if (notice && !lookingAtBubble()) pendingReply = true;
    const base = characterStateFor(observer.status());
    setCharacterState(pendingReply ? base : (flash ?? base));
    if (flash && !pendingReply) setTimeout(() => setCharacterState(characterStateFor(observer.status())), 3000);
    bubble?.webContents.send(IPC.chatThinking, false);
    if (notice) notify(notice.title, notice.body);
  }
}

function lookingAtBubble(): boolean {
  return !!bubble?.isVisible() && !!bubble?.isFocused();
}

function clearPending(): void {
  if (!pendingReply) return;
  pendingReply = false;
  setCharacterState(characterStateFor(observer.status()));
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  if (!shouldNotify({ enabled: config.notifications, bubbleVisible: !!bubble?.isVisible(), bubbleFocused: !!bubble?.isFocused() })) return;
  const n = new Notification({ title, body: notificationBody(body), silent: config.sounds }); // con sonido propio (pop) la notificación va en silencio
  n.on('click', showBubble);
  n.show();
}

// Aprende proyectos y hábitos y los PROPONE (se guardan solo si los apruebas).
let learning = false;
async function runLearning(): Promise<{ created: Memory[]; habitDays: number }> {
  if (learning || !config.memory_enabled) return { created: [], habitDays: 0 };
  learning = true;
  try {
    const r = await learn(db, workRoots());
    if (r.created.length) {
      bubble?.webContents.send(IPC.memoryRefresh);
      const n = r.created.length;
      notify('Agentik aprendió algo de ti', `${n} ${n === 1 ? 'recuerdo nuevo espera' : 'recuerdos nuevos esperan'} tu aprobación en la pestaña Memoria.`);
    }
    return r;
  } finally {
    learning = false;
  }
}

async function learnReply(): Promise<string> {
  if (!config.memory_enabled) return 'La memoria está desactivada en la configuración.';
  const r = await runLearning();
  const out = [r.created.length
    ? `Te propuse ${r.created.length} ${r.created.length === 1 ? 'recuerdo nuevo' : 'recuerdos nuevos'}:\n${r.created.slice(0, 5).map((m) => `• ${m.contenido}`).join('\n')}\nApruébalos en la pestaña Memoria.`
    : 'No encontré nada nuevo que proponerte.'];
  if (r.habitDays < MIN_HABIT_DAYS) out.push(`Los hábitos necesitan al menos ${MIN_HABIT_DAYS} días con el observador activo (llevo ${r.habitDays}).`);
  return out.join('\n');
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
    new_chat: () => { wipeChat(); showBubble(); bubble?.webContents.send(IPC.chatClear); }, // chat nuevo = historial borrado de verdad
  };
  for (const [name, run] of Object.entries(actions)) {
    const accel = config.shortcuts[name as keyof Config['shortcuts']];
    try {
      if (!globalShortcut.register(accel, run)) console.warn(`[agentik] atajo "${accel}" (${name}) ya está en uso`);
    } catch {
      console.warn(`[agentik] atajo inválido "${accel}" (${name})`);
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
  return handleChat(text, { asAssistant: true });
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
  secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  ai = new AiClient(db, config, backupDir, () => {
    const profile = activeProfile();
    if (!profile) throw new Error('No hay ningún modelo configurado. Agrega uno en la pestaña Modelo.');
    return { profile, provider: createProvider(profile, keyFor(profile)) };
  });
  ai.loadHistory(modelContext(db)); // la conversación sigue donde la dejaste
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
    modelsList: modelsState,
    modelsSetActive: handleModelsSetActive,
    modelsSave: handleModelsSave,
    modelsDelete: handleModelsDelete,
    modelsDetect: handleModelsDetect,
    chatStop: stopChat,
    chatHistory: () => loadHistory(db),
    chatClearHistory: wipeChat,
    settingsGet: settingsState,
    settingsSet: handleSettingsSet,
  });

  setInterval(() => void observer.tick(), config.observer_poll_ms);
  setInterval(evaluateSuggestions, SUGGESTION_POLL_MS);
  purgeExpired(db, config.retention_hours, Date.now(), config.habit_retention_days);
  setInterval(() => purgeExpired(db, config.retention_hours, Date.now(), config.habit_retention_days), RETENTION_EVERY_MS);
  fileWatcher = startFileWatcher(config.allowed_folders, (p) => observer.recordFileChange(p));

  registerShortcuts();
  // Aprende de fondo solo si ya activaste el observador (sin tu activación no se observa nada).
  const autoLearn = (): void => { if (observer.status().enabled) void runLearning(); };
  setTimeout(autoLearn, 30_000);
  setInterval(autoLearn, 12 * 3_600_000);

  pushStatus(observer.status());
});

app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  db?.close();
});
