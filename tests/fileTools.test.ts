import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb } from './helpers.js';
import { proposeFileEdit, approveFileEdit, rejectFileEdit, listFileEdits, logAudit, getAuditLog } from '../src/files/fileTools.js';
import type { Config } from '../src/shared/types.js';

const testDir = join(tmpdir(), 'agetik-test-' + Date.now());
const backupDir = join(testDir, 'backups');
const allowedDir = join(testDir, 'allowed');

function testConfig(): Config {
  return {
    allowed_folders: [allowedDir],
    excluded_apps: [],
    excluded_title_patterns: [],
    retention_hours: 24,
    suggestion_level: 'discreto',
    memory_enabled: true,
    memory_max_items_per_request: 5,
    observer_poll_ms: 5000,
  };
}

beforeEach(() => {
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('proposeFileEdit', () => {
  it('rechaza archivos fuera de carpetas autorizadas', () => {
    const db = memoryDb();
    const result = proposeFileEdit(db, testConfig(), '/tmp/outside.txt', 'content');
    expect('error' in result).toBe(true);
  });

  it('rechaza archivos sensibles', () => {
    const db = memoryDb();
    const envFile = join(allowedDir, '.env');
    const result = proposeFileEdit(db, testConfig(), envFile, 'content');
    expect('error' in result).toBe(true);
  });

  it('propone edición de archivo existente', () => {
    const db = memoryDb();
    const file = join(allowedDir, 'test.txt');
    writeFileSync(file, 'línea 1\nlínea 2\n');
    const result = proposeFileEdit(db, testConfig(), file, 'línea 1\nlínea modificada\n');
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.status).toBe('propuesto');
      expect(result.diff).toContain('- línea 2');
      expect(result.diff).toContain('+ línea modificada');
    }
  });

  it('propone creación de archivo nuevo', () => {
    const db = memoryDb();
    const file = join(allowedDir, 'nuevo.txt');
    const result = proposeFileEdit(db, testConfig(), file, 'contenido nuevo');
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.status).toBe('propuesto');
    }
  });
});

describe('approveFileEdit', () => {
  it('crea backup y escribe archivo', () => {
    const db = memoryDb();
    const file = join(allowedDir, 'editable.txt');
    writeFileSync(file, 'original');
    const proposed = proposeFileEdit(db, testConfig(), file, 'modificado');
    expect('id' in proposed).toBe(true);
    if (!('id' in proposed)) return;

    const result = approveFileEdit(db, proposed.id, backupDir);
    expect('id' in result).toBe(true);
    if (!('id' in result)) return;

    expect(result.status).toBe('aplicado');
    expect(result.backup_path).not.toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('modificado');
    expect(existsSync(result.backup_path!)).toBe(true);
    expect(readFileSync(result.backup_path!, 'utf8')).toBe('original');
  });

  it('rechaza edición no propuesta', () => {
    const db = memoryDb();
    const result = approveFileEdit(db, 999, backupDir);
    expect('error' in result).toBe(true);
  });

  it('no aprueba dos veces', () => {
    const db = memoryDb();
    const file = join(allowedDir, 'doble.txt');
    writeFileSync(file, 'v1');
    const proposed = proposeFileEdit(db, testConfig(), file, 'v2');
    if (!('id' in proposed)) return;
    approveFileEdit(db, proposed.id, backupDir);
    const second = approveFileEdit(db, proposed.id, backupDir);
    expect('error' in second).toBe(true);
  });
});

describe('rejectFileEdit', () => {
  it('rechaza edición propuesta', () => {
    const db = memoryDb();
    const file = join(allowedDir, 'rechazar.txt');
    writeFileSync(file, 'original');
    const proposed = proposeFileEdit(db, testConfig(), file, 'cambio');
    if (!('id' in proposed)) return;
    expect(rejectFileEdit(db, proposed.id)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('original');
  });
});

describe('listFileEdits', () => {
  it('lista ediciones recientes', () => {
    const db = memoryDb();
    const file = join(allowedDir, 'list.txt');
    writeFileSync(file, 'x');
    proposeFileEdit(db, testConfig(), file, 'y');
    const list = listFileEdits(db);
    expect(list.length).toBe(1);
    expect(list[0]!.status).toBe('propuesto');
  });
});

describe('audit log', () => {
  it('registra acciones', () => {
    const db = memoryDb();
    logAudit(db, 'test_action', 'detalle');
    const log = getAuditLog(db);
    expect(log.length).toBe(1);
    expect(log[0]!.action).toBe('test_action');
  });

  it('proposeFileEdit crea entrada de auditoría', () => {
    const db = memoryDb();
    const file = join(allowedDir, 'audit.txt');
    writeFileSync(file, 'x');
    proposeFileEdit(db, testConfig(), file, 'y');
    const log = getAuditLog(db);
    expect(log.some(e => e.action === 'file_edit_proposed')).toBe(true);
  });
});
