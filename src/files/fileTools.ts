import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename, dirname, isAbsolute } from 'node:path';
import type { Db } from '../db/db.js';
import type { Config, FileEdit } from '../shared/types.js';
import { isSensitivePath } from '../observer/filters.js';

// ponytail: diff payload stored as JSON in the diff TEXT column
interface DiffPayload {
  preview: string;
  content: string;
}

function isInsideAllowed(config: Config, filePath: string): boolean {
  const abs = resolve(filePath);
  return config.allowed_folders.some(f => abs.startsWith(resolve(f)));
}

function simpleDiff(oldLines: string[], newLines: string[]): string {
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      out.push(`  ${o ?? ''}`);
    } else {
      if (o !== undefined) out.push(`- ${o}`);
      if (n !== undefined) out.push(`+ ${n}`);
    }
  }
  return out.join('\n');
}

export function logAudit(db: Db, action: string, detail?: string): void {
  db.prepare('INSERT INTO audit_log (ts, action, detail) VALUES (?, ?, ?)').run(Date.now(), action, detail ?? null);
}

export function proposeFileEdit(
  db: Db,
  config: Config,
  filePath: string,
  newContent: string,
): FileEdit | { error: string } {
  const abs = resolve(filePath);

  if (!isAbsolute(abs)) return { error: 'Ruta debe ser absoluta' };
  if (isSensitivePath(abs)) return { error: 'Archivo sensible: no se puede editar' };
  if (!isInsideAllowed(config, abs)) return { error: 'Archivo fuera de carpetas autorizadas' };

  let oldContent = '';
  try {
    oldContent = readFileSync(abs, 'utf8');
  } catch {
    // archivo nuevo
  }

  const preview = simpleDiff(oldContent.split('\n'), newContent.split('\n'));
  const payload: DiffPayload = { preview, content: newContent };
  const now = Date.now();

  const result = db.prepare(
    'INSERT INTO file_edits (ts, path, status, diff) VALUES (?, ?, ?, ?)',
  ).run(now, abs, 'propuesto', JSON.stringify(payload));

  logAudit(db, 'file_edit_proposed', abs);

  return {
    id: Number(result.lastInsertRowid),
    ts: now,
    path: abs,
    status: 'propuesto',
    backup_path: null,
    diff: preview,
  };
}

export function approveFileEdit(db: Db, id: number, backupDir: string): FileEdit | { error: string } {
  const row = db.prepare('SELECT * FROM file_edits WHERE id = ?').get(id) as FileEdit & { diff: string } | undefined;
  if (!row) return { error: 'Edición no encontrada' };
  if (row.status !== 'propuesto') return { error: `Estado actual: ${row.status}` };

  let payload: DiffPayload;
  try {
    payload = JSON.parse(row.diff);
  } catch {
    db.prepare('UPDATE file_edits SET status = ? WHERE id = ?').run('fallido', id);
    return { error: 'Datos de edición corruptos' };
  }

  // Backup original
  let backupPath: string | null = null;
  if (existsSync(row.path)) {
    mkdirSync(backupDir, { recursive: true });
    const ts = Date.now();
    backupPath = resolve(backupDir, `${ts}_${basename(row.path)}`);
    try {
      copyFileSync(row.path, backupPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error de backup';
      db.prepare('UPDATE file_edits SET status = ? WHERE id = ?').run('fallido', id);
      logAudit(db, 'file_edit_backup_failed', `${row.path}: ${msg}`);
      return { error: `Backup falló: ${msg}` };
    }
  }

  // Write new content
  try {
    mkdirSync(dirname(row.path), { recursive: true });
    writeFileSync(row.path, payload.content, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error de escritura';
    db.prepare('UPDATE file_edits SET status = ?, backup_path = ? WHERE id = ?').run('fallido', backupPath, id);
    logAudit(db, 'file_edit_write_failed', `${row.path}: ${msg}`);
    return { error: `Escritura falló: ${msg}` };
  }

  db.prepare('UPDATE file_edits SET status = ?, backup_path = ? WHERE id = ?').run('aplicado', backupPath, id);
  logAudit(db, 'file_edit_applied', `${row.path} (backup: ${backupPath ?? 'nuevo'})`);

  return {
    id,
    ts: row.ts,
    path: row.path,
    status: 'aplicado',
    backup_path: backupPath,
    diff: payload.preview,
  };
}

export function rejectFileEdit(db: Db, id: number): boolean {
  const row = db.prepare('SELECT path, status FROM file_edits WHERE id = ?').get(id) as { path: string; status: string } | undefined;
  if (!row || row.status !== 'propuesto') return false;
  db.prepare('UPDATE file_edits SET status = ? WHERE id = ?').run('rechazado', id);
  logAudit(db, 'file_edit_rejected', row.path);
  return true;
}

export function listFileEdits(db: Db): FileEdit[] {
  const rows = db.prepare(
    'SELECT id, ts, path, status, backup_path, diff FROM file_edits ORDER BY ts DESC LIMIT 50',
  ).all() as (FileEdit & { diff: string })[];

  return rows.map(r => {
    let preview = r.diff;
    try {
      const p = JSON.parse(r.diff) as DiffPayload;
      preview = p.preview;
    } catch { /* already plain text or corrupt */ }
    return { ...r, diff: preview };
  });
}

export function getAuditLog(db: Db, limit: number = 50): { id: number; ts: number; action: string; detail: string | null }[] {
  return db.prepare('SELECT id, ts, action, detail FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit) as { id: number; ts: number; action: string; detail: string | null }[];
}
