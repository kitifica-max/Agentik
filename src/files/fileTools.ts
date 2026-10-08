import { readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { resolve, basename, dirname, isAbsolute } from 'node:path';
import type { Db } from '../db/db.js';
import type { Config, FileEdit } from '../shared/types.js';
import { isSensitivePath } from '../observer/filters.js';

export type FileOp = 'write' | 'move' | 'mkdir' | 'copy';

interface OpPayload {
  op: FileOp;
  preview: string;
  content?: string;
  dest?: string;
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

function validatePath(config: Config, filePath: string): string | { error: string } {
  const abs = resolve(filePath);
  if (isSensitivePath(abs)) return { error: 'Archivo sensible: no se puede operar' };
  if (!isInsideAllowed(config, abs)) return { error: 'Fuera de carpetas autorizadas' };
  return abs;
}

function insertOp(db: Db, path: string, payload: OpPayload): FileEdit {
  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO file_edits (ts, path, status, diff) VALUES (?, ?, ?, ?)',
  ).run(now, path, 'propuesto', JSON.stringify(payload));
  logAudit(db, `file_${payload.op}_proposed`, path);
  return { id: Number(result.lastInsertRowid), ts: now, path, status: 'propuesto', backup_path: null, diff: payload.preview };
}

export function proposeFileEdit(
  db: Db, config: Config, filePath: string, newContent: string,
): FileEdit | { error: string } {
  const abs = validatePath(config, filePath);
  if (typeof abs !== 'string') return abs;

  let oldContent = '';
  try { oldContent = readFileSync(abs, 'utf8'); } catch { /* nuevo */ }

  const preview = simpleDiff(oldContent.split('\n'), newContent.split('\n'));
  return insertOp(db, abs, { op: 'write', preview, content: newContent });
}

export function proposeFileMove(
  db: Db, config: Config, src: string, dest: string,
): FileEdit | { error: string } {
  const absSrc = validatePath(config, src);
  if (typeof absSrc !== 'string') return absSrc;
  const absDest = validatePath(config, dest);
  if (typeof absDest !== 'string') return absDest;
  if (!existsSync(absSrc)) return { error: `No existe: ${src}` };

  const preview = `mover: ${absSrc}\n    → ${absDest}`;
  return insertOp(db, absSrc, { op: 'move', preview, dest: absDest });
}

export function proposeFileMkdir(
  db: Db, config: Config, dirPath: string,
): FileEdit | { error: string } {
  const abs = validatePath(config, dirPath);
  if (typeof abs !== 'string') return abs;
  if (existsSync(abs)) return { error: `Ya existe: ${dirPath}` };

  const preview = `crear carpeta: ${abs}`;
  return insertOp(db, abs, { op: 'mkdir', preview });
}

export function proposeFileCopy(
  db: Db, config: Config, src: string, dest: string,
): FileEdit | { error: string } {
  const absSrc = validatePath(config, src);
  if (typeof absSrc !== 'string') return absSrc;
  const absDest = validatePath(config, dest);
  if (typeof absDest !== 'string') return absDest;
  if (!existsSync(absSrc)) return { error: `No existe: ${src}` };

  const preview = `copiar: ${absSrc}\n    → ${absDest}`;
  return insertOp(db, absSrc, { op: 'copy', preview, dest: absDest });
}

export function approveFileEdit(db: Db, id: number, backupDir: string): FileEdit | { error: string } {
  const row = db.prepare('SELECT * FROM file_edits WHERE id = ?').get(id) as FileEdit & { diff: string } | undefined;
  if (!row) return { error: 'Edición no encontrada' };
  if (row.status !== 'propuesto') return { error: `Estado actual: ${row.status}` };

  let payload: OpPayload;
  try {
    payload = JSON.parse(row.diff);
    if (!payload.op) payload.op = 'write';
  } catch {
    db.prepare('UPDATE file_edits SET status = ? WHERE id = ?').run('fallido', id);
    return { error: 'Datos de operación corruptos' };
  }

  let backupPath: string | null = null;
  if (existsSync(row.path)) {
    mkdirSync(backupDir, { recursive: true });
    backupPath = resolve(backupDir, `${Date.now()}_${basename(row.path)}`);
    try {
      copyFileSync(row.path, backupPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error de backup';
      db.prepare('UPDATE file_edits SET status = ? WHERE id = ?').run('fallido', id);
      logAudit(db, `file_${payload.op}_backup_failed`, `${row.path}: ${msg}`);
      return { error: `Backup falló: ${msg}` };
    }
  }

  try {
    switch (payload.op) {
      case 'write':
        mkdirSync(dirname(row.path), { recursive: true });
        writeFileSync(row.path, payload.content!, 'utf8');
        break;
      case 'move':
        mkdirSync(dirname(payload.dest!), { recursive: true });
        renameSync(row.path, payload.dest!);
        break;
      case 'mkdir':
        mkdirSync(row.path, { recursive: true });
        break;
      case 'copy':
        mkdirSync(dirname(payload.dest!), { recursive: true });
        copyFileSync(row.path, payload.dest!);
        break;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error de operación';
    db.prepare('UPDATE file_edits SET status = ?, backup_path = ? WHERE id = ?').run('fallido', backupPath, id);
    logAudit(db, `file_${payload.op}_failed`, `${row.path}: ${msg}`);
    return { error: `Operación falló: ${msg}` };
  }

  db.prepare('UPDATE file_edits SET status = ?, backup_path = ? WHERE id = ?').run('aplicado', backupPath, id);
  logAudit(db, `file_${payload.op}_applied`, `${row.path} (backup: ${backupPath ?? 'nuevo'})`);

  return { id, ts: row.ts, path: row.path, status: 'aplicado', backup_path: backupPath, diff: payload.preview };
}

const OP_ORDER: Record<FileOp, number> = { mkdir: 0, move: 1, copy: 2, write: 3 };

export function approveAllFileEdits(db: Db, backupDir: string): { applied: number; failed: string[] } {
  const rows = db.prepare(
    "SELECT id, diff FROM file_edits WHERE status = 'propuesto' ORDER BY ts ASC",
  ).all() as { id: number; diff: string }[];

  const sorted = rows.sort((a, b) => {
    let opA: FileOp = 'write';
    let opB: FileOp = 'write';
    try { opA = (JSON.parse(a.diff) as OpPayload).op ?? 'write'; } catch {}
    try { opB = (JSON.parse(b.diff) as OpPayload).op ?? 'write'; } catch {}
    return OP_ORDER[opA] - OP_ORDER[opB];
  });

  let applied = 0;
  const failed: string[] = [];
  for (const row of sorted) {
    const result = approveFileEdit(db, row.id, backupDir);
    if ('error' in result) {
      failed.push(result.error);
    } else {
      applied++;
    }
  }
  return { applied, failed };
}

export function rejectAllFileEdits(db: Db): number {
  const rows = db.prepare(
    "SELECT id FROM file_edits WHERE status = 'propuesto'",
  ).all() as { id: number }[];
  let count = 0;
  for (const row of rows) {
    if (rejectFileEdit(db, row.id)) count++;
  }
  return count;
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
      const p = JSON.parse(r.diff) as OpPayload;
      preview = p.preview;
    } catch { /* plain text or corrupt */ }
    return { ...r, diff: preview };
  });
}

export function getAuditLog(db: Db, limit: number = 50): { id: number; ts: number; action: string; detail: string | null }[] {
  return db.prepare('SELECT id, ts, action, detail FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit) as { id: number; ts: number; action: string; detail: string | null }[];
}
