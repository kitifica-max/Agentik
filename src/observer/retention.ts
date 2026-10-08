import type { Db } from '../db/db';

// Borra eventos más viejos que retention_hours. Devuelve filas eliminadas.
export function purgeExpired(db: Db, retentionHours: number, now: number = Date.now()): number {
  const cutoff = now - retentionHours * 3_600_000;
  return db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff).changes;
}
