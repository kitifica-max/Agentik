import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb } from './helpers.js';
import { proposeFileEdit, proposeFileMove, proposeFileMkdir, proposeFileCopy, approveFileEdit, approveAllFileEdits, executeFileOp, organizeFolder, rejectFileEdit, rejectAllFileEdits, listFileEdits, logAudit, getAuditLog } from '../src/files/fileTools.js';
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
    expect(log.some(e => e.action === 'file_write_proposed')).toBe(true);
  });
});

describe('proposeFileMove', () => {
  it('propone mover archivo existente', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'mover.txt');
    const dest = join(allowedDir, 'sub/movido.txt');
    writeFileSync(src, 'data');
    const result = proposeFileMove(db, testConfig(), src, dest);
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.diff).toContain('mover:');
    }
  });

  it('rechaza mover archivo inexistente', () => {
    const db = memoryDb();
    const result = proposeFileMove(db, testConfig(), join(allowedDir, 'nope.txt'), join(allowedDir, 'dest.txt'));
    expect('error' in result).toBe(true);
  });

  it('rechaza mover fuera de carpetas autorizadas', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'a.txt');
    writeFileSync(src, 'x');
    const result = proposeFileMove(db, testConfig(), src, '/tmp/outside.txt');
    expect('error' in result).toBe(true);
  });
});

describe('proposeFileMkdir', () => {
  it('propone crear carpeta nueva', () => {
    const db = memoryDb();
    const dir = join(allowedDir, 'nueva-carpeta');
    const result = proposeFileMkdir(db, testConfig(), dir);
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.diff).toContain('crear carpeta:');
    }
  });

  it('rechaza carpeta que ya existe', () => {
    const db = memoryDb();
    const result = proposeFileMkdir(db, testConfig(), allowedDir);
    expect('error' in result).toBe(true);
  });
});

describe('proposeFileCopy', () => {
  it('propone copiar archivo', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'original.txt');
    const dest = join(allowedDir, 'copia.txt');
    writeFileSync(src, 'contenido');
    const result = proposeFileCopy(db, testConfig(), src, dest);
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.diff).toContain('copiar:');
    }
  });
});

describe('approveFileEdit ops', () => {
  it('aprueba move: mueve archivo', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'mv-src.txt');
    const dest = join(allowedDir, 'mv-dest.txt');
    writeFileSync(src, 'mover esto');
    const proposed = proposeFileMove(db, testConfig(), src, dest);
    if (!('id' in proposed)) return;
    const result = approveFileEdit(db, proposed.id, backupDir);
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.status).toBe('aplicado');
      expect(existsSync(dest)).toBe(true);
      expect(existsSync(src)).toBe(false);
    }
  });

  it('aprueba mkdir: crea carpeta', () => {
    const db = memoryDb();
    const dir = join(allowedDir, 'nueva');
    const proposed = proposeFileMkdir(db, testConfig(), dir);
    if (!('id' in proposed)) return;
    const result = approveFileEdit(db, proposed.id, backupDir);
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it('aprueba copy: copia archivo', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'cp-src.txt');
    const dest = join(allowedDir, 'cp-dest.txt');
    writeFileSync(src, 'copiar esto');
    const proposed = proposeFileCopy(db, testConfig(), src, dest);
    if (!('id' in proposed)) return;
    const result = approveFileEdit(db, proposed.id, backupDir);
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(readFileSync(dest, 'utf8')).toBe('copiar esto');
      expect(existsSync(src)).toBe(true);
    }
  });
});

describe('approveAllFileEdits', () => {
  it('aprueba todas en orden correcto (mkdir antes de move)', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'batch-file.txt');
    const subdir = join(allowedDir, 'batch-sub');
    const dest = join(subdir, 'batch-file.txt');
    writeFileSync(src, 'batch');

    proposeFileMkdir(db, testConfig(), subdir);
    proposeFileMove(db, testConfig(), src, dest);

    const result = approveAllFileEdits(db, backupDir);
    expect(result.applied).toBe(2);
    expect(result.failed.length).toBe(0);
    expect(existsSync(subdir)).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(src)).toBe(false);
  });

  it('retorna 0 si no hay pendientes', () => {
    const db = memoryDb();
    const result = approveAllFileEdits(db, backupDir);
    expect(result.applied).toBe(0);
  });
});

describe('rejectAllFileEdits', () => {
  it('rechaza todas las pendientes', () => {
    const db = memoryDb();
    const f1 = join(allowedDir, 'rej1.txt');
    const f2 = join(allowedDir, 'rej2.txt');
    writeFileSync(f1, 'a');
    writeFileSync(f2, 'b');
    proposeFileEdit(db, testConfig(), f1, 'x');
    proposeFileEdit(db, testConfig(), f2, 'y');

    const count = rejectAllFileEdits(db);
    expect(count).toBe(2);

    const list = listFileEdits(db);
    expect(list.every(e => e.status === 'rechazado')).toBe(true);
  });
});

describe('executeFileOp', () => {
  it('mueve una carpeta completa (antes fallaba en el backup)', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'dir-src');
    mkdirSync(src);
    writeFileSync(join(src, 'a.txt'), 'a');
    const r = executeFileOp(db, testConfig(), backupDir, 'move', src, { dest: join(allowedDir, 'Agrupado/dir-src') });
    expect(r.success).toBe(true);
    expect(existsSync(join(allowedDir, 'Agrupado/dir-src/a.txt'))).toBe(true);
  });

  it('no pisa un destino existente', () => {
    const db = memoryDb();
    const src = join(allowedDir, 's.txt');
    const dest = join(allowedDir, 'd.txt');
    writeFileSync(src, 'src');
    writeFileSync(dest, 'dest');
    const r = executeFileOp(db, testConfig(), backupDir, 'move', src, { dest });
    expect(r.success).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('dest');
    expect(existsSync(src)).toBe(true);
  });

  it('destino carpeta existente: mueve dentro con el mismo nombre', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'x.txt');
    const folder = join(allowedDir, 'Docs');
    writeFileSync(src, 'x');
    mkdirSync(folder);
    const r = executeFileOp(db, testConfig(), backupDir, 'move', src, { dest: folder });
    expect(r.success).toBe(true);
    expect(existsSync(join(folder, 'x.txt'))).toBe(true);
  });

  it('destino terminado en "/" es carpeta, no renombra el archivo', () => {
    const db = memoryDb();
    const src = join(allowedDir, 'cap.png');
    writeFileSync(src, 'x');
    const r = executeFileOp(db, testConfig(), backupDir, 'move', src, { dest: join(allowedDir, 'Capturas/2026-05') + '/' });
    expect(r.success).toBe(true);
    expect(existsSync(join(allowedDir, 'Capturas/2026-05/cap.png'))).toBe(true);
  });

  it('write respalda el original; mkdir es idempotente; ruta ausente no lanza', () => {
    const db = memoryDb();
    const f = join(allowedDir, 'w.txt');
    writeFileSync(f, 'v1');
    expect(executeFileOp(db, testConfig(), backupDir, 'write', f, { content: 'v2' }).success).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('v2');
    expect(executeFileOp(db, testConfig(), backupDir, 'mkdir', allowedDir).success).toBe(true);
    expect(executeFileOp(db, testConfig(), backupDir, 'move', undefined as unknown as string).success).toBe(false);
  });

  it('rechaza fuera de carpetas autorizadas', () => {
    const db = memoryDb();
    expect(executeFileOp(db, testConfig(), backupDir, 'mkdir', '/tmp/fuera-agetik').success).toBe(false);
  });
});

describe('organizeFolder', () => {
  it('mueve por reglas y agrupa por mes (fecha del nombre)', () => {
    const db = memoryDb();
    writeFileSync(join(allowedDir, 'Captura de pantalla 2026-05-16 a la(s) 9.45.png'), 'x');
    writeFileSync(join(allowedDir, 'Captura de pantalla 2026-06-02 a la(s) 1.10.png'), 'x');
    writeFileSync(join(allowedDir, 'informe.PDF'), 'x');
    writeFileSync(join(allowedDir, 'notas.xyz'), 'x');
    mkdirSync(join(allowedDir, 'CarpetaVieja'));
    const r = organizeFolder(db, testConfig(), backupDir, allowedDir, [
      { name_contains: 'Captura de pantalla', dest: 'Capturas' },
      { extensions: ['.pdf'], dest: 'Docs' },
    ], 'month');
    expect(r.moved).toBe(3);
    expect(r.skipped).toBe(1);
    expect(existsSync(join(allowedDir, 'Capturas/2026-05/Captura de pantalla 2026-05-16 a la(s) 9.45.png'))).toBe(true);
    expect(existsSync(join(allowedDir, 'Capturas/2026-06'))).toBe(true);
    expect(existsSync(join(allowedDir, 'Docs', new Date().getFullYear().toString() + '-' + String(new Date().getMonth() + 1).padStart(2, '0'), 'informe.PDF'))).toBe(true);
    expect(existsSync(join(allowedDir, 'notas.xyz'))).toBe(true);
    expect(existsSync(join(allowedDir, 'CarpetaVieja'))).toBe(true);
  });

  it('rechaza carpetas fuera de las autorizadas', () => {
    const db = memoryDb();
    const r = organizeFolder(db, testConfig(), backupDir, '/tmp', [{ extensions: ['png'], dest: 'X' }]);
    expect(r.moved).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
