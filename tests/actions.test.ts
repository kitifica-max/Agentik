import { describe, it, expect } from 'vitest';
import { actionLine, actionsBlock } from '../src/ai/actions.js';

describe('actionLine', () => {
  it('resume organize_folder con nombre base y primera línea del resultado', () => {
    expect(actionLine('organize_folder', { folder: '/Users/x/Downloads' }, '130 movidos (Imágenes: 100), 4 sin regla.')).toBe('organize_folder Downloads → 130 movidos (Imágenes: 100), 4 sin regla.');
  });
  it('no registra herramientas de solo lectura ni rutas sensibles', () => {
    expect(actionLine('read_file', { path: '/a/b.txt' }, 'contenido')).toBeNull();
    expect(actionLine('list_folder', { path: '/a' }, 'x')).toBeNull();
    expect(actionLine('write_file', { path: '/a/.env', content: 'K=1' }, 'ok')).toBeNull();
    expect(actionLine('move_files', { moves: [{ source: '/a/id_rsa', destination: '/b/id_rsa' }] }, '1/1 movidos.')).toBeNull();
  });
  it('write_file no incluye contenido; run_command omite comandos con secretos', () => {
    const l = actionLine('write_file', { path: '/a/notas.md', content: 'SECRETO-contenido' }, 'Archivo escrito')!;
    expect(l).toBe('write_file notas.md');
    expect(actionLine('run_command', { command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwx" x' }, 'exit 0')).toBe('run_command');
    expect(actionLine('run_command', { command: 'ls -la ~/Downloads' }, 'exit 0')).toBe('run_command ls -la ~/Downloads');
  });
  it('move_files incluye la carpeta destino por nombre base', () => {
    expect(actionLine('move_files', { moves: [{ source: '/a/x.pdf', destination: '/a/Docs/x.pdf' }] }, '1/1 movidos.')).toBe('move_files → 1/1 movidos. (a Docs)');
  });
  it('actionsBlock deja como máximo 5 líneas (las últimas)', () => {
    const b = actionsBlock(['1', '2', '3', '4', '5', '6', '7']);
    expect(b.split('\n').filter((x) => /^\d$/.test(x))).toEqual(['3', '4', '5', '6', '7']);
    expect(actionsBlock([])).toBe('');
  });
});
