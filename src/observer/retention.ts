import type { Db } from '../db/db';

// Borra eventos más viejos que retention_hours y el resumen de hábitos más viejo que habitDays.
// Devuelve las filas de events eliminadas.
export function purgeExpired(db: Db, retentionHours: number, now: number = Date.now(), habitDays = 60): number {
  const cutoff = now - retentionHours * 3_600_000;
  const n = db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff).changes;
  const d = new Date(now - habitDays * 86_400_000);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  db.prepare('DELETE FROM habit_stats WHERE day < ?').run(day);
  return n;
}
