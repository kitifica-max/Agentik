import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Attachments, describeAttachments, namesLine, MAX_FILES } from '../src/chat/attachments.js';

let base: string, src: string, root: string, at: Attachments;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'agentik-att-')); src = join(base, 'origen'); root = join(base, 'adjuntos'); mkdirSync(src); at = new Attachments(root); });
afterEach(() => rmSync(base, { recursive: true, force: true }));
const mk = (name: string, c = 'x') => { const p = join(src, name); writeFileSync(p, c); return p; };

describe('adjuntos del chat', () => {
  it('copia los archivos (el original no se toca) y los lista; los repetidos reciben otro nombre', () => {
    const a = mk('informe.pdf', 'uno');
    const r = at.stage(1, [a, a]);
    expect(r.rejected).toEqual([]);
    expect(r.files.map((f) => f.name)).toEqual(['informe.pdf', 'informe (2).pdf']);
    expect(readFileSync(r.files[0]!.path, 'utf8')).toBe('uno');
    expect(readFileSync(a, 'utf8')).toBe('uno');
    expect(r.files[0]!.path.startsWith(root)).toBe(true);
    expect(at.list(1)).toHaveLength(2);
    expect(at.list(2)).toEqual([]); // cada conversación tiene su borrador
  });

  it('rechaza con motivo: carpetas, inexistentes, sensibles y el exceso sobre el tope', () => {
    mkdirSync(join(src, 'carpeta'));
    const r = at.stage(1, [join(src, 'carpeta'), join(src, 'no-existe.txt'), mk('.env'), mk('credentials.txt'), mk('ok.txt')]);
    expect(r.files.map((f) => f.name)).toEqual(['ok.txt']);
    expect(r.rejected.map((x) => x.reason)).toEqual(['solo se pueden adjuntar archivos, no carpetas', 'no existe', 'es un archivo sensible', 'es un archivo sensible']);
    const many = Array.from({ length: MAX_FILES + 3 }, (_, i) => mk(`f${i}.txt`));
    const r2 = at.stage(2, many);
    expect(r2.files).toHaveLength(MAX_FILES);
    expect(r2.rejected).toHaveLength(3);
    expect(r2.rejected[0]!.reason).toMatch(/máximo 10/);
  });

  it('quitar un adjunto borra su copia y no afecta al original', () => {
    const a = mk('a.txt'); const [f] = at.stage(1, [a]).files;
    expect(at.remove(1, f!.id)).toBe(true);
    expect(existsSync(f!.path)).toBe(false);
    expect(existsSync(a)).toBe(true);
    expect(at.remove(1, 'inexistente')).toBe(false);
  });

  it('al enviar, el borrador pasa a ser la carpeta del mensaje y el borrador queda vacío', () => {
    at.stage(1, [mk('a.pdf'), mk('b.pdf')]);
    const c = at.commit(1)!;
    expect(c.files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(c.files.every((f) => existsSync(f.path) && f.path.startsWith(c.dir))).toBe(true);
    expect(at.list(1)).toEqual([]);
    expect(at.commit(1)).toBeNull();
    expect(describeAttachments(c)).toContain(c.dir);
    expect(describeAttachments(c)).toContain('run_script');
    expect(namesLine(c.files)).toBe('📎 a.pdf, b.pdf');
  });

  it('limpia: una conversación, todo, lo viejo y los borradores huérfanos', () => {
    at.stage(1, [mk('a.txt')]); const c1 = at.commit(1)!;
    at.stage(2, [mk('b.txt')]); const c2 = at.commit(2)!;
    at.stage(2, [mk('c.txt')]); // borrador sin enviar
    at.purgeConversation(1);
    expect(existsSync(c1.dir)).toBe(false);
    expect(existsSync(c2.dir)).toBe(true);
    const old = Date.now() / 1000 - 20 * 86400;
    utimesSync(c2.dir, old, old);
    const fresh = new Attachments(root); // otra sesión: el borrador de antes ya no se usa
    expect(fresh.purgeOld()).toBe(2); // el mensaje viejo y el borrador huérfano
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
    at.stage(3, [mk('d.txt')]); at.clearDrafts();
    expect(at.list(3)).toEqual([]);
    at.stage(4, [mk('e.txt')]); at.commit(4); at.purgeAll();
    expect(existsSync(root)).toBe(false);
  });
});
