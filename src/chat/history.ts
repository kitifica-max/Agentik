import type { Db } from '../db/db.js';
import { getState, setState } from '../db/db.js';
import type { ChatMessage } from '../shared/types.js';

// Historial del chat: vive solo en tu Mac (SQLite) hasta que lo borres. 'kind' distingue lo que pasó
// por el modelo ('ai') de respuestas locales, errores y paradas: al reabrir, el modelo solo recupera 'ai'.
// Los mensajes se agrupan en conversaciones; una está activa y es la que ve y recuerda el modelo.
export type ChatKind = 'ai' | 'local' | 'error' | 'stopped';
export interface StoredMessage { id: number; ts: number; role: 'user' | 'assistant'; content: string; kind: ChatKind }

export const MAX_STORED = 500; // mensajes en total; al pasar de aquí se descartan los más viejos
export const MAX_CONVERSATIONS = 20;
export const WARN_AT = MAX_CONVERSATIONS - 2; // la interfaz avisa desde aquí
const TITLE_MAX = 40;

// Si pegaste una clave por error, no se guarda en el historial.
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{32,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[clave oculta]'), text);
}

// ── Conversaciones ───────────────────────────────────────────────────────────────────────────
export interface Conversation { id: number; title: string; updated: number; pinned: boolean; messages: number; preview: string }

const ACTIVE_KEY = 'active_conversation';

function makeConversation(db: Db, now = Date.now()): number {
  const id = Number(db.prepare('INSERT INTO conversations (title, created, updated) VALUES (?, ?, ?)').run('', now, now).lastInsertRowid);
  setState(db, ACTIVE_KEY, String(id));
  return id;
}

export function titleFrom(text: string): string {
  const t = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t;
}

/** La conversación activa. Si no hay ninguna la crea y adopta los mensajes guardados antes de que existieran las conversaciones. */
export function activeConversation(db: Db): number {
  const saved = Number(getState(db, ACTIVE_KEY));
  if (saved && db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(saved)) return saved;
  const latest = db.prepare('SELECT id FROM conversations ORDER BY updated DESC, id DESC LIMIT 1').get() as { id: number } | undefined;
  if (latest) { setState(db, ACTIVE_KEY, String(latest.id)); return latest.id; }
  const id = makeConversation(db);
  const legacy = db.prepare('SELECT content, ts FROM chat_messages WHERE conversation_id IS NULL ORDER BY id').all() as { content: string; ts: number }[];
  if (legacy.length) {
    const first = db.prepare("SELECT content FROM chat_messages WHERE conversation_id IS NULL AND role = 'user' ORDER BY id LIMIT 1").get() as { content: string } | undefined;
    db.prepare('UPDATE chat_messages SET conversation_id = ? WHERE conversation_id IS NULL').run(id);
    db.prepare('UPDATE conversations SET title = ?, updated = ? WHERE id = ?').run(first ? titleFrom(first.content) : 'Conversación anterior', legacy[legacy.length - 1]!.ts, id);
  }
  return id;
}

export function listConversations(db: Db): { active: number; items: Conversation[]; max: number; warnAt: number } {
  const active = activeConversation(db);
  const rows = db.prepare(`
    SELECT c.id, c.title, c.updated, c.pinned,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS messages,
           COALESCE((SELECT m.content FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1), '') AS preview
    FROM conversations c ORDER BY c.pinned DESC, c.updated DESC, c.id DESC`).all() as { id: number; title: string; updated: number; pinned: number; messages: number; preview: string }[];
  const items = rows.map((r) => ({ id: r.id, title: r.title, updated: r.updated, pinned: !!r.pinned, messages: r.messages, preview: r.preview.replace(/\s+/g, ' ').slice(0, 80) }));
  return { active, items, max: MAX_CONVERSATIONS, warnAt: WARN_AT };
}

/** Borra una conversación de verdad (sobrescribe el contenido). Devuelve cuántos mensajes se fueron. */
function purge(db: Db, id: number): number {
  db.pragma('secure_delete = ON');
  const n = db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id).changes;
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return n;
}

/** Empieza una conversación nueva. Si ya estás en una vacía, la reutiliza. Al pasar el tope borra la más vieja sin fijar. */
export function newConversation(db: Db, now = Date.now()): { id: number; evicted: number } | { error: 'all-pinned' } {
  const cur = activeConversation(db);
  const empty = (db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?').get(cur) as { n: number }).n === 0;
  if (empty) return { id: cur, evicted: 0 };
  const total = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
  let evicted = 0;
  if (total >= MAX_CONVERSATIONS) {
    const oldest = db.prepare('SELECT id FROM conversations WHERE pinned = 0 AND id != ? ORDER BY updated ASC, id ASC LIMIT 1').get(cur) as { id: number } | undefined;
    if (!oldest) return { error: 'all-pinned' };
    purge(db, oldest.id);
    evicted = 1;
  }
  return { id: makeConversation(db, now), evicted };
}

export function openConversation(db: Db, id: number): boolean {
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) return false;
  setState(db, ACTIVE_KEY, String(id));
  return true;
}

export function setPinned(db: Db, id: number, pinned: boolean): boolean {
  return db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id).changes > 0;
}

/** Borra una conversación. Si era la activa pasa a la más reciente, o a una vacía si no queda ninguna. */
export function deleteConversation(db: Db, id: number): boolean {
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) return false;
  const wasActive = activeConversation(db) === id;
  purge(db, id);
  db.pragma('wal_checkpoint(TRUNCATE)');
  if (wasActive) {
    const next = db.prepare('SELECT id FROM conversations ORDER BY updated DESC, id DESC LIMIT 1').get() as { id: number } | undefined;
    if (next) setState(db, ACTIVE_KEY, String(next.id)); else makeConversation(db);
  }
  return true;
}

// ── Mensajes (siempre de la conversación activa) ───────────────────────────────────────────────
/** Guarda un intercambio (tu mensaje y la respuesta) en una sola transacción. user = null: solo la respuesta. */
export function saveExchange(db: Db, user: string | null, assistant: string, kind: ChatKind, now = Date.now()): void {
  const conv = activeConversation(db);
  const ins = db.prepare('INSERT INTO chat_messages (ts, role, content, kind, conversation_id) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    if (user !== null) ins.run(now, 'user', redactSecrets(user), kind, conv);
    ins.run(now + 1, 'assistant', redactSecrets(assistant), kind, conv);
    const row = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conv) as { title: string };
    db.prepare('UPDATE conversations SET updated = ?, title = ? WHERE id = ?').run(now + 1, row.title || (user !== null ? titleFrom(user) : titleFrom(assistant)), conv);
    db.prepare('DELETE FROM chat_messages WHERE id <= (SELECT MAX(id) FROM chat_messages) - ?').run(MAX_STORED);
    // conversaciones que se quedaron sin mensajes por el tope (menos la activa y las fijadas)
    db.prepare('DELETE FROM conversations WHERE id != ? AND pinned = 0 AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = conversations.id)').run(conv);
  })();
}

export function loadHistory(db: Db, limit = 200): StoredMessage[] {
  const rows = db.prepare('SELECT id, ts, role, content, kind FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(activeConversation(db), limit) as StoredMessage[];
  return rows.reverse();
}

/** Lo que se le devuelve al modelo al reabrir: solo intercambios de la conversación activa que pasaron por él. */
export function modelContext(db: Db, limit = 30): ChatMessage[] {
  const rows = db.prepare("SELECT role, content FROM chat_messages WHERE kind = 'ai' AND conversation_id = ? ORDER BY id DESC LIMIT ?").all(activeConversation(db), limit) as ChatMessage[];
  return rows.reverse();
}

export function historyCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n;
}

/** Borra TODO el historial de verdad (todas las conversaciones): sobrescribe lo borrado y vacía el archivo de registro (WAL). */
export function clearHistory(db: Db): number {
  db.pragma('secure_delete = ON');
  const n = db.prepare('DELETE FROM chat_messages').run().changes;
  db.prepare('DELETE FROM conversations').run();
  db.prepare('DELETE FROM app_state WHERE key = ?').run(ACTIVE_KEY);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return n;
}
