import Database from 'better-sqlite3';

export type Db = Database.Database;

// Esquema completo (plan). Fase 1 usa events y app_state; el resto se usa en fases siguientes.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('app_focus','file_change')),
  app         TEXT,
  title       TEXT,
  path        TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS memories (
  id           INTEGER PRIMARY KEY,
  contenido    TEXT NOT NULL,
  tipo         TEXT NOT NULL CHECK (tipo IN ('preferencia','proyecto','decisión','contexto')),
  fuente       TEXT NOT NULL,
  estado       TEXT NOT NULL CHECK (estado IN ('propuesto','aprobado','rechazado')),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_estado ON memories(estado);

CREATE TABLE IF NOT EXISTS file_edits (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  path        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('propuesto','aprobado','rechazado','aplicado','fallido')),
  backup_path TEXT,
  diff        TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY,
  ts     INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function getState(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
