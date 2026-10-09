import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, utimesSync, symlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { memoryDb, cfg } from './helpers.js';
import { planScript, runScript, undoRun, listRuns, listScripts, type Deps } from '../src/scripts/engine.js';
import { resolveBin } from '../src/scripts/modules.js';

let base: string, work: string, trash: string;
let deps: Deps;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agentik-scr-'));
  work = join(base, 'Trabajo'); trash = join(base, 'Papelera');
  mkdirSync(work); mkdirSync(trash);
  deps = { db: memoryDb(), config: { ...cfg, allowed_folders: [work] }, trashDir: trash, bin: (n) => resolveBin(n) };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const put = (rel: string, content: string | Buffer = 'x', mtimeSec?: number) => {
  const p = join(work, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content);
  if (mtimeSec) utimesSync(p, mtimeSec, mtimeSec);
  return p;
};
const names = (dir: string) => readdirSync(dir).sort();
const DAY = 86400;
const old = (days: number) => Math.floor(Date.now() / 1000) - days * DAY;

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(t)); return Buffer.concat([len, t, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 128);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('motor de scripts', () => {
  it('lista la biblioteca con su grupo, riesgo y herramientas que faltan', () => {
    const l = listScripts({ bin: () => null });
    expect(l.length).toBeGreaterThan(10);
    expect(l.find((s) => s.id === 'duplicados')).toMatchObject({ group: 'todos', risk: 'mueve', missing: [] });
    expect(l.find((s) => s.id === 'imagenes-convertir')!.missing).toEqual(['sips']);
  });

  it('valida parámetros: obligatorios, números, carpeta fuera de lo autorizado y script inexistente', async () => {
    expect(await planScript(deps, 'nada', {})).toMatchObject({ ok: false });
    expect(await planScript(deps, 'duplicados', {})).toEqual({ ok: false, error: 'Falta «Carpeta»' });
    const fuera = join(base, 'Otra'); mkdirSync(fuera);
    expect(await planScript(deps, 'duplicados', { carpeta: fuera })).toMatchObject({ ok: false, error: expect.stringMatching(/autorizadas/) });
    expect(await planScript(deps, 'pesados-viejos', { carpeta: work, minMB: -3 })).toMatchObject({ ok: false });
  });

  it('la vista previa no cambia nada', async () => {
    put('a.txt', 'igual'); put('b.txt', 'igual');
    const before = names(work);
    const r = await planScript(deps, 'duplicados', { carpeta: work });
    expect(r.ok && r.plan.count).toBe(1);
    expect(names(work)).toEqual(before);
    expect(deps.db.prepare('SELECT COUNT(*) AS n FROM script_runs').get()).toEqual({ n: 0 });
  });
});

describe('duplicados', () => {
  it('deja el más antiguo, mueve los idénticos y no confunde mismo tamaño con mismo contenido', async () => {
    put('orig.txt', 'contenido-uno', old(10)); put('copia.txt', 'contenido-uno', old(1)); put('sub/otra copia.txt', 'contenido-uno', old(2));
    put('mismo-tamano.txt', 'contenido-dos'); put('vacio1.txt', ''); put('vacio2.txt', '');
    const r = await runScript(deps, 'duplicados', { carpeta: work });
    expect(r.ok && r.summary).toMatch(/2 duplicados/);
    expect(existsSync(join(work, 'orig.txt'))).toBe(true);
    expect(names(join(work, 'Duplicados'))).toEqual(['copia.txt', 'otra copia.txt']);
    expect(existsSync(join(work, 'mismo-tamano.txt'))).toBe(true);
    expect(existsSync(join(work, 'vacio1.txt')) && existsSync(join(work, 'vacio2.txt'))).toBe(true); // vacíos no cuentan
  });

  it('deshacer devuelve todo a su sitio, y no se puede deshacer dos veces', async () => {
    put('a.txt', 'dup', old(5)); put('b.txt', 'dup', old(1));
    const r = await runScript(deps, 'duplicados', { carpeta: work });
    if (!r.ok) throw new Error(r.error);
    expect(r.undoable).toBe(true);
    expect(existsSync(join(work, 'b.txt'))).toBe(false);
    expect(undoRun(deps, r.runId)).toEqual({ ok: true, restored: 1, skipped: 0 });
    expect(existsSync(join(work, 'b.txt'))).toBe(true);
    expect(undoRun(deps, r.runId)).toMatchObject({ ok: false });
    expect(listRuns(deps.db)[0]).toMatchObject({ script: 'duplicados', undone: true, undoable: false });
  });

  it('no sigue enlaces simbólicos ni toca archivos ocultos o sensibles', async () => {
    put('a.txt', 'dup', old(5)); put('.oculto', 'dup', old(1)); put('credentials.txt', 'dup', old(1));
    symlinkSync(join(work, 'a.txt'), join(work, 'enlace.txt'));
    const r = await planScript(deps, 'duplicados', { carpeta: work });
    expect(r.ok && r.plan.count).toBe(0);
  });
});

describe('pesados y viejos', () => {
  it('mueve solo lo que cumple ambas condiciones (peso Y antigüedad)', async () => {
    put('grande-viejo.bin', Buffer.alloc(2 * 1024 * 1024), old(400));
    put('grande-nuevo.bin', Buffer.alloc(2 * 1024 * 1024), old(1));
    put('chico-viejo.txt', 'x', old(400));
    const r = await runScript(deps, 'pesados-viejos', { carpeta: work, minMB: 1, dias: 180 });
    expect(r.ok && r.summary).toMatch(/1 archivo/);
    expect(names(join(work, 'Revisar', 'Pesados y viejos'))).toEqual(['grande-viejo.bin']);
    expect(existsSync(join(work, 'grande-nuevo.bin')) && existsSync(join(work, 'chico-viejo.txt'))).toBe(true);
  });
});

describe('escáner de secretos', () => {
  it('encuentra secretos y archivos sensibles pero NUNCA muestra su valor ni abre los .env', async () => {
    const SECRETO = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    put('config.js', `const k = "${SECRETO}";\nconst otro = 1;`);
    put('.env', 'API_KEY=SUPERVALOR-DEL-ENV-1234567890');
    put('limpio.txt', 'nada que ver');
    const r = await runScript(deps, 'escaner-secretos', { carpeta: work });
    if (!r.ok) throw new Error(r.error);
    const todo = JSON.stringify(r);
    expect(r.lines.some((l) => l.startsWith('config.js:1'))).toBe(true);
    expect(r.lines.some((l) => l.startsWith('.env') && /no lo abro/.test(l))).toBe(true);
    expect(todo).not.toContain(SECRETO);
    expect(todo).not.toContain('SUPERVALOR');
    expect(r.lines.some((l) => l.startsWith('limpio.txt'))).toBe(false);
    expect(r.undoable).toBe(false); // solo lee
  });
});

describe('capturas, carpetas vacías y zips', () => {
  it('capturas viejas a Capturas/AAAA-MM; las recientes y otros archivos se quedan', async () => {
    put('Captura de pantalla 2026-01-05.png', 'x', Math.floor(new Date('2026-01-05T12:00:00').getTime() / 1000));
    put('Captura reciente.png', 'x', old(1)); put('foto.png', 'x', old(300));
    const r = await runScript(deps, 'capturas', { carpeta: work, dias: 14 });
    expect(r.ok && r.summary).toMatch(/1 captura/);
    expect(existsSync(join(work, 'Capturas', '2026-01', 'Captura de pantalla 2026-01-05.png'))).toBe(true);
    expect(existsSync(join(work, 'Captura reciente.png')) && existsSync(join(work, 'foto.png'))).toBe(true);
  });

  it('carpetas vacías: solo la más externa de cada rama, y no las que tienen algo', async () => {
    mkdirSync(join(work, 'a/b/c'), { recursive: true }); mkdirSync(join(work, 'llena')); put('llena/x.txt'); mkdirSync(join(work, 'solo-ds'), { recursive: true }); put('solo-ds/.DS_Store');
    const r = await runScript(deps, 'carpetas-vacias', { carpeta: work });
    expect(r.ok && r.summary).toMatch(/2 carpetas movidas/);
    expect(names(join(work, 'Revisar', 'Carpetas vacías'))).toEqual(['a', 'solo-ds']);
    expect(existsSync(join(work, 'llena', 'x.txt'))).toBe(true);
  });

  it('descomprime cada zip en su carpeta, guarda el original, y deshacer lo revierte', async () => {
    put('docs/uno.txt', 'hola'); execFileSync('zip', ['-qr', join(work, 'paquete.zip'), 'docs'], { cwd: work }); rmSync(join(work, 'docs'), { recursive: true });
    const r = await runScript(deps, 'descomprimir-zips', { carpeta: work });
    if (!r.ok) throw new Error(r.error);
    expect(readFileSync(join(work, 'paquete', 'docs', 'uno.txt'), 'utf8')).toBe('hola');
    expect(existsSync(join(work, 'Zips originales', 'paquete.zip'))).toBe(true);
    expect(undoRun(deps, r.runId)).toMatchObject({ ok: true });
    expect(existsSync(join(work, 'paquete.zip'))).toBe(true);
    expect(existsSync(join(work, 'paquete'))).toBe(false);
    expect(names(trash)).toEqual(['paquete']); // lo creado va a la Papelera, no se borra
  });
});

describe('imágenes (sips)', () => {
  const mac = process.platform === 'darwin';
  it.skipIf(!mac)('convierte PNG a JPG en «Convertidas» sin tocar el original; deshacer manda las copias a la Papelera', async () => {
    put('foto.png', png(8, 8));
    const r = await runScript(deps, 'imagenes-convertir', { carpeta: work, formato: 'jpg', calidad: 80 });
    if (!r.ok) throw new Error(r.error);
    expect(names(join(work, 'Convertidas'))).toEqual(['foto.jpg']);
    expect(readFileSync(join(work, 'Convertidas', 'foto.jpg'))[0]).toBe(0xff); // cabecera JPEG
    expect(existsSync(join(work, 'foto.png'))).toBe(true);
    expect(undoRun(deps, r.runId)).toMatchObject({ ok: true });
    expect(existsSync(join(work, 'Convertidas', 'foto.jpg'))).toBe(false);
  });

  it.skipIf(!mac)('redimensiona solo las que pasan del límite y nunca agranda', async () => {
    put('grande.png', png(40, 20)); put('chica.png', png(6, 6));
    const r = await runScript(deps, 'imagenes-redimensionar', { carpeta: work, lado: 100 });
    expect(r.ok && r.summary).toMatch(/Ninguna imagen pasa de 100px/);
  });

  it.skipIf(!mac)('redimensiona al lado pedido', async () => {
    put('grande.png', png(400, 200)); put('chica.png', png(60, 30));
    const r = await runScript(deps, 'imagenes-redimensionar', { carpeta: work, lado: 100 });
    if (!r.ok) throw new Error(r.error);
    expect(names(join(work, 'Redimensionadas'))).toEqual(['grande.png']);
    const out = execFileSync('sips', ['-g', 'pixelWidth', join(work, 'Redimensionadas', 'grande.png')]).toString();
    expect(out).toMatch(/pixelWidth: 100/);
  });

  it('renombra por fecha (con la fecha del archivo si no hay metadatos) y se deshace', async () => {
    const t = Math.floor(new Date('2026-03-04T09:08:07').getTime() / 1000);
    put('IMG_0001.jpg', 'a', t); put('IMG_0002.jpg', 'b', t); put('2026-01-01_000000.jpg', 'ya', t);
    const d2 = { ...deps, bin: () => null }; // sin mdls: usa la fecha de modificación
    const r = await runScript(d2, 'renombrar-fecha', { carpeta: work });
    if (!r.ok) throw new Error(r.error);
    expect(names(work)).toEqual(['2026-01-01_000000.jpg', '2026-03-04_090807-2.jpg', '2026-03-04_090807.jpg']);
    expect(undoRun(d2, r.runId)).toMatchObject({ ok: true, restored: 2 });
    expect(names(work)).toEqual(['2026-01-01_000000.jpg', 'IMG_0001.jpg', 'IMG_0002.jpg']);
  });
});

describe('desarrollo', () => {
  it('puertos: ve un puerto abierto; cerrar-puerto cierra solo ese proceso', async () => {
    const srv = createServer(); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const r = await planScript(deps, 'puertos', {});
    expect(r.ok && r.plan.lines.some((l) => l.startsWith(`:${port} `))).toBe(true);
    srv.close();
    const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)});setInterval(()=>{},1000)"]);
    const cport = await new Promise<number>((res) => child.stdout.once('data', (d) => res(Number(String(d).trim()))));
    const run = await runScript(deps, 'cerrar-puerto', { puerto: cport });
    expect(run.ok && run.summary).toMatch(/1 proceso/);
    await new Promise((res) => child.once('exit', res));
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('node_modules: manda a la Papelera solo los de proyectos abandonados, y se deshace', async () => {
    put('viejo/package.json', '{}', old(200)); put('viejo/node_modules/x/index.js', 'x'.repeat(5000));
    put('activo/package.json', '{}', old(1)); put('activo/node_modules/y/index.js', 'y');
    const r = await runScript(deps, 'node-modules-viejos', { carpeta: work, dias: 60 });
    if (!r.ok) throw new Error(r.error);
    expect(existsSync(join(work, 'viejo', 'node_modules'))).toBe(false);
    expect(existsSync(join(work, 'activo', 'node_modules'))).toBe(true);
    expect(names(trash)).toEqual(['node_modules']);
    expect(undoRun(deps, r.runId)).toMatchObject({ ok: true, restored: 1 });
    expect(existsSync(join(work, 'viejo', 'node_modules', 'x', 'index.js'))).toBe(true);
  });

  it('.env.example: solo nombres de variables, jamás valores; no pisa uno existente', async () => {
    put('app/.env', '# comentario secreto\nAPI_KEY=valor-super-secreto-123\nexport DB_URL=postgres://u:pw@h/db\nVACIA=\n');
    put('otro/.env', 'X=1'); put('otro/.env.example', 'X=');
    const r = await runScript(deps, 'env-example', { carpeta: work });
    if (!r.ok) throw new Error(r.error);
    const ex = readFileSync(join(work, 'app', '.env.example'), 'utf8');
    expect(ex).toBe('API_KEY=\nDB_URL=\nVACIA=\n');
    expect(JSON.stringify(r)).not.toMatch(/valor-super|postgres|pw@/);
    expect(readFileSync(join(work, 'otro', '.env.example'), 'utf8')).toBe('X=');
  });

  it('estado de repos: detecta cambios sin commit', async () => {
    const repo = join(work, 'proy'); mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'uno');
    let r = await runScript(deps, 'repos-estado', { carpeta: work });
    expect(r.ok && r.lines[0]).toMatch(/proy.*main.*limpio/);
    writeFileSync(join(repo, 'b.txt'), '2');
    r = await runScript(deps, 'repos-estado', { carpeta: work });
    expect(r.ok && r.lines[0]).toMatch(/1 cambio/);
  });
});
