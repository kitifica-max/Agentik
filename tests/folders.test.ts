import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb, cfg } from './helpers.js';
import { isWithin, broadFolderReason, sanitizeFolders } from '../src/shared/paths.js';
import { proposeFileEdit, executeFileOp } from '../src/files/fileTools.js';
import { startFileWatcher } from '../src/observer/fileWatcher.js';
import { AiClient } from '../src/ai/client.js';
import type { Provider, LlmResult } from '../src/ai/providers.js';

let base: string, home: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'agentik-folders-'));
  home = join(base, 'home');
  for (const d of ['Documents', 'Downloads', 'Library/Application Support', 'Proyectos/app']) mkdirSync(join(home, d), { recursive: true });
  symlinkSync('/', join(base, 'Macintosh HD')); // así se ve el disco en el selector de carpetas de macOS
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('isWithin', () => {
  it('respeta los límites de carpeta (antes /a/Down abarcaba /a/Downloads2)', () => {
    expect(isWithin('/a/Down', '/a/Down/x/y')).toBe(true);
    expect(isWithin('/a/Down', '/a/Down')).toBe(true);
    expect(isWithin('/a/Down', '/a/Downloads2/x')).toBe(false);
    expect(isWithin('/a/Down', '/a/../b')).toBe(false);
    expect(isWithin('/a/Down', '/a')).toBe(false);
  });
});

describe('broadFolderReason: qué carpetas son demasiado amplias', () => {
  it('el disco entero, también cuando lo eliges como "Macintosh HD" (un enlace a /)', () => {
    expect(broadFolderReason('/', home)).toBe('es todo el disco');
    expect(broadFolderReason(join(base, 'Macintosh HD'), home)).toBe('es todo el disco');
  });

  it('discos completos y carpetas del sistema', () => {
    expect(broadFolderReason('/Volumes/Disco Externo', home)).toBe('es un disco completo');
    for (const p of ['/Users', '/Volumes', '/Applications', '/System', '/System/Library', '/usr', '/usr/local', '/Library', '/Library/Application Support', '/etc', '/private/var', '/private']) {
      expect(broadFolderReason(p, home), p).toBe('es una carpeta del sistema');
    }
  });

  it('toda tu carpeta personal y Library; sus subcarpetas de trabajo sí se pueden usar', () => {
    expect(broadFolderReason(home, home)).toBe('es toda tu carpeta personal');
    expect(broadFolderReason(join(home, 'Library'), home)).toMatch(/Library/);
    expect(broadFolderReason(join(home, 'Library', 'Application Support'), home)).toMatch(/Library/);
    for (const ok of ['Documents', 'Downloads', 'Proyectos', 'Proyectos/app']) expect(broadFolderReason(join(home, ok), home), ok).toBeNull();
  });

  it('subcarpetas de un disco externo y carpetas temporales son válidas; una ruta relativa no', () => {
    expect(broadFolderReason('/Volumes/Disco Externo/Proyectos', home)).toBeNull();
    expect(broadFolderReason(join(base, 'home', 'Documents'), home)).toBeNull(); // bajo /var/folders (como las de las pruebas)
    expect(broadFolderReason('Documents', home)).toBe('no es una ruta absoluta');
  });

  it('sanitizeFolders conserva las buenas (sin repetir) y explica las que quita', () => {
    const docs = join(home, 'Documents');
    const r = sanitizeFolders(['/', docs, docs, '/System', home], home);
    expect(r.kept).toEqual([docs]);
    expect(r.removed).toEqual([
      { path: '/', reason: 'es todo el disco' },
      { path: '/System', reason: 'es una carpeta del sistema' },
      { path: home, reason: 'es toda tu carpeta personal' },
    ]);
  });
});

describe('aunque la carpeta mala ya esté en la configuración, no concede permiso', () => {
  const db = memoryDb();
  it('las herramientas de archivos rechazan todo con "/" autorizado', () => {
    const bad = { ...cfg, allowed_folders: ['/'] };
    expect('error' in proposeFileEdit(db, bad, join(base, 'x.txt'), 'x')).toBe(true);
    expect(executeFileOp(db, bad, join(base, 'b'), 'mkdir', join(base, 'nueva')).success).toBe(false);
    expect(executeFileOp(db, { ...cfg, allowed_folders: [join(base, 'Macintosh HD')] }, join(base, 'b'), 'mkdir', join(base, 'otra')).success).toBe(false);
  });

  it('una carpeta con el mismo prefijo no se cuela (/a/Down no autoriza /a/Downloads2)', () => {
    const allowed = join(base, 'Down');
    mkdirSync(allowed);
    mkdirSync(join(base, 'Downloads2'));
    const c = { ...cfg, allowed_folders: [allowed] };
    expect('error' in proposeFileEdit(db, c, join(base, 'Downloads2', 'f.txt'), 'x')).toBe(true);
    expect('error' in proposeFileEdit(db, c, join(allowed, 'f.txt'), 'x')).toBe(false);
  });

  it('el agente tampoco puede listar ni leer a través de "/"', async () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    const turns: LlmResult[] = [
      { text: '', toolCalls: [{ id: 'a', name: 'list_folder', input: { path: '/etc' } }, { id: 'b', name: 'read_file', input: { path: '/etc/hosts' } }], usage, stop: 'tool_use',
        assistantMsg: { role: 'assistant', content: [] } },
      { text: 'no pude', toolCalls: [], usage, stop: 'end', assistantMsg: { role: 'assistant', content: [] } },
    ];
    let i = 0; const seen: any[] = [];
    const provider: Provider = { chat: async (req) => { seen.push(JSON.parse(JSON.stringify(req.messages.at(-1)))); return turns[i++]!; } };
    const ai = new AiClient(db, { ...cfg, allowed_folders: ['/'], memory_enabled: false }, join(base, 'b'), () => ({ provider, profile: { id: 'p', label: 'p', provider: 'ollama', model: 'm' } }));
    await ai.chat('lista /etc');
    const results = seen[1].content as { is_error: boolean; content: string }[];
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(results[0]!.content).toMatch(/Fuera de carpetas autorizadas/);
  });
});

describe('el vigilante de archivos no puede tumbar la app', () => {
  it('no vigila el disco entero ni carpetas del sistema', () => {
    expect(startFileWatcher(['/'], () => {})).toBeNull();
    expect(startFileWatcher([join(base, 'Macintosh HD'), '/System'], () => {})).toBeNull();
  });

  it('un error del vigilante se registra y no se lanza (antes cerraba la app)', async () => {
    const w = startFileWatcher([join(base, 'home', 'Documents')], () => {})!;
    expect(w).not.toBeNull();
    expect(() => w.emit('error', new Error('EMFILE: too many open files'))).not.toThrow();
    await w.close();
  });
});
