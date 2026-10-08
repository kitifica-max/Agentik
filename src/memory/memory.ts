import type { Db } from '../db/db.js';
import type { Memory, MemoryTipo } from '../shared/types.js';
import { isSensitiveText } from './filters.js';

export function proposeMemory(db: Db, contenido: string, tipo: MemoryTipo, fuente: string): Memory | null {
  if (isSensitiveText(contenido)) return null;
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO memories (contenido, tipo, fuente, estado, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(contenido, tipo, fuente, 'propuesto', now);
  return { id: Number(info.lastInsertRowid), contenido, tipo, fuente, estado: 'propuesto', created_at: now, last_used_at: null, expires_at: null };
}

export function approveMemory(db: Db, id: number): boolean {
  return db.prepare('UPDATE memories SET estado = ? WHERE id = ? AND estado = ?').run('aprobado', id, 'propuesto').changes > 0;
}

export function rejectMemory(db: Db, id: number): boolean {
  return db.prepare('UPDATE memories SET estado = ? WHERE id = ? AND estado = ?').run('rechazado', id, 'propuesto').changes > 0;
}

export function deleteMemory(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

export function listMemories(db: Db, estado?: string): Memory[] {
  if (estado) {
    return db.prepare('SELECT * FROM memories WHERE estado = ? ORDER BY created_at DESC').all(estado) as Memory[];
  }
  return db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all() as Memory[];
}

export function approvedMemoriesForContext(db: Db, max: number): Memory[] {
  const rows = db.prepare('SELECT * FROM memories WHERE estado = ? ORDER BY last_used_at DESC, created_at DESC LIMIT ?').all('aprobado', max) as Memory[];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const now = Date.now();
    db.prepare(`UPDATE memories SET last_used_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(now, ...ids);
  }
  return rows;
}
