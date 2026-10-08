import type { Db } from '../db/db';
import type { Config, NewEvent } from '../shared/types';
import { isExcludedWindow, isSensitivePath } from './filters';

const MAX_TITLE = 200;
const HOUR_MS = 3_600_000;

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Suma el tiempo de uso por día, hora y app (sin títulos). Un uso largo se reparte entre las horas que cruza.
export function addHabitStats(db: Db, ts: number, durationMs: number, app: string): void {
  const up = db.prepare(
    'INSERT INTO habit_stats (day, hour, app, ms) VALUES (?, ?, ?, ?) ON CONFLICT(day, hour, app) DO UPDATE SET ms = ms + excluded.ms',
  );
  let t = ts;
  let left = Math.min(durationMs, 24 * HOUR_MS);
  while (left > 0) {
    const d = new Date(t);
    const next = new Date(d);
    next.setMinutes(0, 0, 0);
    next.setHours(d.getHours() + 1);
    const chunk = Math.min(left, next.getTime() - t);
    up.run(dayKey(d), d.getHours(), app, chunk);
    t += chunk;
    left -= chunk;
  }
}

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
  if (ev.kind === 'app_focus' && ev.app && (ev.duration_ms ?? 0) > 0) addHabitStats(db, ev.ts, ev.duration_ms!, ev.app);
  return true;
}
