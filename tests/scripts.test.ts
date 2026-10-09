import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, utimesSync, symlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { memoryDb, cfg } from './helpers.js';
import { planScript, runScript, undoRun, listRuns, listScripts, type Deps } from '../src/scripts/engine.js';
import { resolveBin, installModule, moduleStatus, MODULES } from '../src/scripts/modules.js';
import { sandboxProfile } from '../src/scripts/engine.js';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parseFactura } from '../src/scripts/library/oficina.js';

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

async function pdf(pages: string[]): Promise<Buffer> {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (const text of pages) { const pg = d.addPage([400, 300]); text.split('\n').forEach((l, i) => pg.drawText(l, { x: 20, y: 270 - i * 18, size: 12, font: f })); }
  return Buffer.from(await d.save());
}
const mac = process.platform === 'darwin';

describe('oficina', () => {
  it('une PDFs en orden natural (2 antes que 10) y deshacer manda el resultado a la Papelera', async () => {
    put('10-fin.pdf', await pdf(['diez'])); put('2-medio.pdf', await pdf(['dos', 'dos b'])); put('1-inicio.pdf', await pdf(['uno']));
    const pl = await planScript(deps, 'pdf-unir', { carpeta: work, nombre: 'Todo' });
    expect(pl.ok && pl.plan.lines.map((l) => l.replace(/\s+\(.*/, ''))).toEqual(['1. 1-inicio.pdf', '2. 2-medio.pdf', '3. 10-fin.pdf']);
    const r = await runScript(deps, 'pdf-unir', { carpeta: work, nombre: 'Todo' });
    if (!r.ok) throw new Error(r.error);
    const out = await PDFDocument.load(readFileSync(join(work, 'Unidos', 'Todo.pdf')));
    expect(out.getPageCount()).toBe(4);
    expect(existsSync(join(work, '1-inicio.pdf'))).toBe(true);
    expect(undoRun(deps, r.runId)).toMatchObject({ ok: true });
    expect(existsSync(join(work, 'Unidos', 'Todo.pdf'))).toBe(false);
  });

  it('con menos de 2 PDFs no hace nada, y un PDF dañado no rompe a los demás', async () => {
    put('solo.pdf', await pdf(['x']));
    expect(await runScript(deps, 'pdf-unir', { carpeta: work })).toMatchObject({ ok: true, summary: expect.stringMatching(/al menos 2/) });
    put('malo.pdf', 'esto no es un pdf'); put('otro.pdf', await pdf(['y']));
    const r = await runScript(deps, 'pdf-unir', { carpeta: work });
    expect(r.ok && r.summary).toMatch(/No pude leer: malo\.pdf/);
  });

  it('divide un PDF de a N páginas en una carpeta nueva junto al original', async () => {
    const f = put('libro.pdf', await pdf(['1', '2', '3', '4', '5']));
    const r = await runScript(deps, 'pdf-dividir', { archivo: f, cada: 2 });
    if (!r.ok) throw new Error(r.error);
    expect(names(join(work, 'libro (dividido)'))).toEqual(['libro_p001-p002.pdf', 'libro_p003-p004.pdf', 'libro_p005.pdf']);
    expect((await PDFDocument.load(readFileSync(join(work, 'libro (dividido)', 'libro_p005.pdf')))).getPageCount()).toBe(1);
    expect(await planScript(deps, 'pdf-dividir', { archivo: put('nota.txt') })).toMatchObject({ ok: false, error: 'Elige un archivo PDF' });
  });

  it('parseFactura: fecha ISO, latina y en palabras; total con formatos mixtos; proveedor', () => {
    expect(parseFactura('Papelería El Sol\nFactura No. 123\nFecha: 05/03/2026\nTotal $ 1,234.50')).toEqual({ fecha: '2026-03-05', proveedor: 'Papelería El Sol', total: '1234.50' });
    expect(parseFactura('ACME S.A.\n2026-10-09\nTOTAL: 1.234,50').total).toBe('1234.50');
    expect(parseFactura('Servicios Web\n12 de septiembre de 2026\nTotal 99').fecha).toBe('2026-09-12');
    expect(parseFactura('sin fecha ni nada').fecha).toBeNull();
    expect(parseFactura('Tienda\n31/13/2026').fecha).toBeNull(); // mes imposible
  });

  it.skipIf(!mac)('facturas: lee el texto del PDF con PDFKit, ordena por año/mes y manda las dudosas a Revisar', async () => {
    put('f1.pdf', await pdf(['Papeleria El Sol', 'Factura No. 1', 'Fecha: 05/03/2026', 'Total: 250.75']));
    put('f2.pdf', await pdf(['Un documento cualquiera sin fecha']));
    const r = await runScript(deps, 'facturas', { carpeta: work });
    if (!r.ok) throw new Error(r.error);
    expect(existsSync(join(work, 'Facturas', '2026', '03', '2026-03-05_Papeleria El Sol_250.75.pdf'))).toBe(true);
    expect(existsSync(join(work, 'Facturas', 'Revisar', 'f2.pdf'))).toBe(true);
    expect(undoRun(deps, r.runId)).toMatchObject({ ok: true, restored: 2 });
    expect(existsSync(join(work, 'f1.pdf')) && existsSync(join(work, 'f2.pdf'))).toBe(true);
  });

  it('limpia un CSV: duplicados, columnas vacías, espacios y totales; no toca el original', async () => {
    const f = put('datos.csv', 'nombre,monto,vacia\n Ana ,10,\nLuis,20.5,\nAna,10,\n,,\nLuis,20.5,\n');
    const r = await runScript(deps, 'csv-limpiar', { archivo: f });
    if (!r.ok) throw new Error(r.error);
    expect(readFileSync(join(work, 'datos_limpio.csv'), 'utf8')).toBe('nombre,monto\nAna,10\nLuis,20.5\n');
    expect(r.lines).toContain('Total monto: 30.5');
    expect(readFileSync(f, 'utf8')).toContain(' Ana ');
    const again = await planScript(deps, 'csv-limpiar', { archivo: join(work, 'datos_limpio.csv') });
    expect(again.ok && again.plan.summary).toBe('El CSV ya está limpio.');
  });

  it.skipIf(!mac)('documentos a texto: RTF con textutil y PDF con PDFKit', async () => {
    put('nota.rtf', '{\\rtf1\\ansi Hola mundo desde RTF}'); put('pdf.pdf', await pdf(['Texto dentro del PDF']));
    const r = await runScript(deps, 'docs-a-texto', { carpeta: work });
    if (!r.ok) throw new Error(r.error);
    expect(readFileSync(join(work, 'Texto', 'nota.txt'), 'utf8')).toContain('Hola mundo desde RTF');
    expect(readFileSync(join(work, 'Texto', 'pdf.txt'), 'utf8')).toContain('Texto dentro del PDF');
  });

  it.skipIf(!mac)('atajo de macOS: si no existe lo dice y lista los disponibles, sin ejecutar nada', async () => {
    const r = await runScript(deps, 'atajo-macos', { nombre: 'atajo-que-no-existe-xyz' });
    expect(r.ok && r.summary).toMatch(/No encuentro un Atajo/);
  });
});

describe('sandbox', () => {
  const run = (d: Deps, cmd: string, args: string[], writeDirs: string[]) => import('../src/scripts/engine.js').then(async () => {
    const { execFile } = await import('node:child_process');
    return new Promise<{ code: number; err: string }>((res) => execFile('/usr/bin/sandbox-exec', ['-p', sandboxProfile(writeDirs), cmd, ...args], (e, _o, se) => res({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as unknown as { code: number }).code : 1) : 0, err: String(se) })));
  });
  it.skipIf(!mac)('solo deja escribir en las carpetas permitidas', async () => {
    const { homedir } = await import('node:os');
    const ok = join(homedir(), `agentik-sandbox-ok-${process.pid}`); const no = join(homedir(), `agentik-sandbox-no-${process.pid}.txt`); mkdirSync(ok);
    try {
      expect((await run(deps, '/bin/sh', ['-c', `echo hola > "${ok}/a.txt"`], [ok])).code).toBe(0);
      expect(existsSync(join(ok, 'a.txt'))).toBe(true);
      expect((await run(deps, '/bin/sh', ['-c', `echo hola > "${no}"`], [ok])).code).not.toBe(0);
      expect(existsSync(no)).toBe(false);
    } finally { rmSync(ok, { recursive: true, force: true }); rmSync(no, { force: true }); }
  });
  it.skipIf(!mac)('bloquea la red', async () => {
    const srv = createServer((s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi')); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const libre = await new Promise<number>((res) => { import('node:child_process').then(({ execFile }) => execFile('/usr/bin/curl', ['-s', '-m', '3', `http://127.0.0.1:${port}`], (e) => res(e ? 1 : 0))); });
    const enjaulado = await run(deps, '/usr/bin/curl', ['-s', '-m', '3', `http://127.0.0.1:${port}`], []);
    srv.close();
    expect(libre).toBe(0);
    expect(enjaulado.code).not.toBe(0);
  });
  it('rechaza rutas que romperían el perfil', () => {
    expect(() => sandboxProfile(['/tmp/a"b'])).toThrow(/no permitida/i);
    expect(sandboxProfile([join(base, 'carpeta (con paréntesis)')])).toContain('(deny network*)');
  });
});

describe('módulos', () => {
  const body = Buffer.from('datos-del-modelo-de-prueba');
  const fetchOf = (buf: Buffer, status = 200) => async () => ({ ok: status === 200, status, body: new Response(buf).body });
  const spec = MODULES.find((m) => m.id === 'whisper-model-tiny')!;

  it('los modelos de voz solo se instalan si la descarga coincide con la suma SHA-256', async () => {
    const dir = join(base, 'mods');
    const real = spec.how as { kind: 'model'; sha256: string; bytes: number };
    const orig = { sha: real.sha256, bytes: real.bytes };
    real.sha256 = createHash('sha256').update(body).digest('hex'); real.bytes = body.length; // modelo falso, pequeño
    try {
      expect(await installModule('whisper-model-tiny', { modulesDir: dir, fetchImpl: fetchOf(Buffer.from('otra cosa!!!!!!!!!!!!!!!!')) })).toMatchObject({ ok: false, error: expect.stringMatching(/suma de verificación/) });
      expect(resolveBin('whisper-model-tiny', dir)).toBeNull();
      expect(readdirSync(join(dir, 'whisper'))).toEqual([]); // no deja restos
      expect(await installModule('whisper-model-tiny', { modulesDir: dir, fetchImpl: fetchOf(body) })).toEqual({ ok: true });
      expect(readFileSync(resolveBin('whisper-model-tiny', dir)!)).toEqual(body);
      expect(moduleStatus(dir).find((m) => m.id === 'whisper-model-tiny')!.installed).toBe(true);
      expect(await installModule('whisper-model-tiny', { modulesDir: dir, fetchImpl: async () => { throw new Error('no debería descargar'); } })).toEqual({ ok: true }); // ya estaba
    } finally { real.sha256 = orig.sha; real.bytes = orig.bytes; }
  });

  it('errores claros: descarga fallida, módulo inexistente y Homebrew ausente', async () => {
    const dir = join(base, 'mods2');
    expect(await installModule('whisper-model-base', { modulesDir: dir, fetchImpl: fetchOf(body, 404) })).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 404/) });
    expect(await installModule('nada', { modulesDir: dir })).toMatchObject({ ok: false });
    expect(await installModule('whisper-cli', { modulesDir: join(base, 'sin-bin'), brew: null })).toMatchObject({ ok: false, error: expect.stringMatching(/Homebrew/) });
  });

  it('los modelos pinneados tienen suma y tamaño conocidos', () => {
    for (const m of MODULES.filter((x) => x.how.kind === 'model')) {
      const h = m.how as { sha256: string; bytes: number; url: string };
      expect(h.sha256).toMatch(/^[0-9a-f]{64}$/); expect(h.bytes).toBeGreaterThan(1e7); expect(h.url.startsWith('https://huggingface.co/')).toBe(true);
    }
  });
});

describe('contenido (ffmpeg y whisper)', () => {
  const ffmpeg = resolveBin('ffmpeg');
  const mkVideo = (name: string) => { const f = join(work, name); execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=96x64:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-pix_fmt', 'yuv420p', '-y', f]); return f; };

  it.skipIf(!ffmpeg)('comprime videos a MP4 en «Comprimidos» sin tocar el original, y se deshace', async () => {
    mkVideo('clip.mov');
    const r = await runScript(deps, 'video-comprimir', { carpeta: work, calidad: 'baja' });
    if (!r.ok) throw new Error(r.error);
    expect(r.summary).toMatch(/1 video comprimido/);
    expect(existsSync(join(work, 'Comprimidos', 'clip.mp4'))).toBe(true);
    expect(existsSync(join(work, 'clip.mov'))).toBe(true);
    expect(undoRun(deps, r.runId)).toMatchObject({ ok: true });
    expect(existsSync(join(work, 'Comprimidos', 'clip.mp4'))).toBe(false);
  });

  it.skipIf(!ffmpeg)('extrae el audio y hace un GIF', async () => {
    const v = mkVideo('clip.mp4');
    const a = await runScript(deps, 'audio-extraer', { carpeta: work, formato: 'm4a' });
    expect(a.ok && a.summary).toMatch(/1 audio extraído/);
    expect(existsSync(join(work, 'Audio', 'clip.m4a'))).toBe(true);
    const g = await runScript(deps, 'video-gif', { archivo: v, ancho: 120, segundos: 1 });
    if (!g.ok) throw new Error(g.error);
    expect(readFileSync(join(work, 'GIFs', 'clip.gif')).subarray(0, 3).toString()).toBe('GIF');
  });

  it.skipIf(!ffmpeg)('transcribe con Whisper (simulado): convierte a WAV, corre dentro del sandbox y guarda el texto', async () => {
    const v = mkVideo('charla.mp4');
    const fake = join(base, 'whisper-cli'); const model = join(base, 'ggml-base.bin');
    writeFileSync(model, 'm');
    writeFileSync(fake, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -of) OF="$2"; shift;; -l) LANG_="$2"; shift;; -f) IN="$2"; shift;; esac; shift; done\n[ -s "$IN" ] || exit 3\necho "hola desde whisper ($LANG_)" > "$OF.txt"\n');
    chmodSync(fake, 0o755);
    const d2: Deps = { ...deps, bin: (n) => (n === 'whisper-cli' ? fake : n === 'whisper-model-base' ? model : resolveBin(n)) };
    expect(await planScript({ ...deps, bin: (n) => (n === 'whisper-cli' ? fake : resolveBin(n)) }, 'transcribir', { archivo: v })).toMatchObject({ ok: false, error: expect.stringMatching(/Falta el modelo/) });
    const r = await runScript(d2, 'transcribir', { archivo: v, idioma: 'es' });
    if (!r.ok) throw new Error(r.error);
    expect(readFileSync(join(work, 'Transcripciones', 'charla.txt'), 'utf8')).toBe('hola desde whisper (es)\n');
    expect(await planScript(d2, 'transcribir', { archivo: put('nota.txt') })).toMatchObject({ ok: false, error: 'Elige un archivo de audio o video' });
  });

  it('sin la herramienta instalada avisa qué falta, sin ejecutar nada', async () => {
    mkVideo2();
    const sin: Deps = { ...deps, bin: () => null };
    expect(await runScript(sin, 'video-comprimir', { carpeta: work })).toEqual({ ok: false, error: 'Falta instalar: ffmpeg' });
    function mkVideo2() { put('v.mp4', 'no es video'); }
  });
});
