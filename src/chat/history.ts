import type { Db } from '../db/db.js';
import type { ChatMessage } from '../shared/types.js';

// Historial del chat: vive solo en tu Mac (SQLite) hasta que lo borres. 'kind' distingue lo que pasó
// por el modelo ('ai') de respuestas locales, errores y paradas: al reabrir, el modelo solo recupera 'ai'.
export type ChatKind = 'ai' | 'local' | 'error' | 'stopped';
export interface StoredMessage { id: number; ts: number; role: 'user' | 'assistant'; content: string; kind: ChatKind }

export const MAX_STORED = 500; // al pasar de aquí se descartan los más viejos

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

/** Guarda un intercambio (tu mensaje y la respuesta) en una sola transacción. user = null: solo la respuesta. */
export function saveExchange(db: Db, user: string | null, assistant: string, kind: ChatKind, now = Date.now()): void {
  const ins = db.prepare('INSERT INTO chat_messages (ts, role, content, kind) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    if (user !== null) ins.run(now, 'user', redactSecrets(user), kind);
    ins.run(now + 1, 'assistant', redactSecrets(assistant), kind);
    db.prepare('DELETE FROM chat_messages WHERE id <= (SELECT MAX(id) FROM chat_messages) - ?').run(MAX_STORED);
  })();
}

export function loadHistory(db: Db, limit = 200): StoredMessage[] {
  const rows = db.prepare('SELECT id, ts, role, content, kind FROM chat_messages ORDER BY id DESC LIMIT ?').all(limit) as StoredMessage[];
  return rows.reverse();
}

/** Lo que se le devuelve al modelo al reabrir: solo intercambios que pasaron por él. */
export function modelContext(db: Db, limit = 30): ChatMessage[] {
  const rows = db.prepare("SELECT role, content FROM chat_messages WHERE kind = 'ai' ORDER BY id DESC LIMIT ?").all(limit) as ChatMessage[];
  return rows.reverse();
}

export function historyCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n;
}

/** Borra TODO el historial de verdad: sobrescribe el contenido borrado y vacía el archivo de registro (WAL). */
export function clearHistory(db: Db): number {
  db.pragma('secure_delete = ON');
  const n = db.prepare('DELETE FROM chat_messages').run().changes;
  db.pragma('wal_checkpoint(TRUNCATE)');
  return n;
}
