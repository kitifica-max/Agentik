import type { Db } from '../db/db';
import type { Config, NewEvent } from '../shared/types';
import { isExcludedWindow, isSensitivePath } from './filters';

const MAX_TITLE = 200;

// Única puerta a la tabla events. Si el evento está excluido, no toca la base de datos.
export function recordEvent(db: Db, cfg: Config, ev: NewEvent): boolean {
  if (ev.kind === 'app_focus') {
    if (!ev.app || isExcludedWindow(cfg, ev.app, ev.title ?? '')) return false;
  }
  if (ev.kind === 'file_change') {
    if (!ev.path || isSensitivePath(ev.path)) return false;
  }
  db.prepare('INSERT INTO events (ts, kind, app, title, path, duration_ms) VALUES (?, ?, ?, ?, ?, ?)').run(
    ev.ts,
    ev.kind,
    ev.app ?? null,
    ev.title ? ev.title.slice(0, MAX_TITLE) : null,
    ev.path ?? null,
    ev.duration_ms ?? null,
  );
  return true;
}
