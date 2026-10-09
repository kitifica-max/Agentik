import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb, cfg } from './helpers.js';
import { matchRecipe, runRecipe } from '../src/ai/recipes.js';
import { AiClient } from '../src/ai/client.js';
import type { Provider } from '../src/ai/providers.js';

let base: string, downloads: string, outside: string;
const config = () => ({ ...cfg, allowed_folders: [downloads] });
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agentik-rec-'));
  downloads = join(base, 'Downloads'); outside = join(base, 'Otra');
  mkdirSync(downloads); mkdirSync(outside);
  for (const f of ['a.png', 'b.JPG', 'c.pdf', 'd.xlsx', 'e.mp4', 'f.mp3', 'g.zip', 'h.dmg', 'raro.xyz']) writeFileSync(join(downloads, f), 'x');
  writeFileSync(join(outside, 'z.png'), 'x');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('matchRecipe', () => {
  it('coincide con "organiza <carpeta autorizada>" por nombre, alias o ruta', () => {
    for (const t of ['organiza Downloads', 'Organiza mi carpeta downloads', 'ordena downloads por favor', 'organiza Downloads.', 'organiza descargas', `organiza ${downloads}`]) {
      expect(matchRecipe(t, config()), t).toEqual({ id: 'script', script: 'organizar-por-tipo', params: { carpeta: downloads } });
    }
  });
  it('no coincide fuera de las carpetas autorizadas, con peticiones más complejas ni con rutas inexistentes o sensibles', () => {
    for (const t of ['organiza Otra', `organiza ${outside}`, 'organiza /', 'organiza Downloads y borra los zip', 'organiza Downloads por mes', 'qué hay en Downloads', 'organiza Fantasma', 'organiza ~/.ssh', `organiza ${join(downloads, 'nada')}`]) {
      expect(matchRecipe(t, config()), t).toBeNull();
    }
    expect(matchRecipe('organiza Downloads', { ...cfg, allowed_folders: [] })).toBeNull();
  });
  it('no coincide si dos carpetas autorizadas se llaman igual (ambigüedad: decide el modelo)', () => {
    mkdirSync(join(base, 'x')); mkdirSync(join(base, 'x', 'Downloads'));
    expect(matchRecipe('organiza Downloads', { ...cfg, allowed_folders: [downloads, join(base, 'x', 'Downloads')] })).toBeNull();
  });
});

describe('runRecipe', () => {
  it('mueve archivos solo dentro de la carpeta autorizada, con las reglas por defecto, y deja el audit', async () => {
    const db = memoryDb();
    const m = matchRecipe('organiza Downloads', config())!;
    const r = await runRecipe(m, { db, config: config(), backupDir: join(base, 'backups'), trashDir: join(base, 'Papelera') });
    expect(r.ops).toBe(8);
    expect(r.reply).toBe('Listo, organicé Downloads: 8 archivos en 7 carpetas. Si no te gusta, di «deshaz».');
    expect(existsSync(join(downloads, 'Imágenes', 'a.png'))).toBe(true);
    expect(existsSync(join(downloads, 'Imágenes', 'b.JPG'))).toBe(true);
    expect(existsSync(join(downloads, 'Documentos', 'c.pdf'))).toBe(true);
    expect(existsSync(join(downloads, 'Hojas', 'd.xlsx'))).toBe(true);
    expect(existsSync(join(downloads, 'Video', 'e.mp4'))).toBe(true);
    expect(existsSync(join(downloads, 'Audio', 'f.mp3'))).toBe(true);
    expect(existsSync(join(downloads, 'Comprimidos', 'g.zip'))).toBe(true);
    expect(existsSync(join(downloads, 'Instaladores', 'h.dmg'))).toBe(true);
    expect(existsSync(join(downloads, 'raro.xyz'))).toBe(true); // sin regla: se queda
    expect(existsSync(join(outside, 'z.png'))).toBe(true); // nada fuera de la carpeta autorizada
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'recipe'").all() as { detail: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toContain('organizar-por-tipo');
  });
  it('si no hay nada que organizar lo dice sin tocar nada', async () => {
    const db = memoryDb();
    const empty = join(base, 'Vacia'); mkdirSync(empty);
    const c = { ...cfg, allowed_folders: [empty] };
    const r = await runRecipe(matchRecipe('organiza Vacia', c)!, { db, config: c, backupDir: join(base, 'backups') });
    expect(r.ops).toBe(0);
    expect(r.reply).toMatch(/No hay archivos sueltos/);
  });
});

describe('AiClient con recetas', () => {
  it('resuelve "organiza Downloads" sin llamar al modelo ni resolverlo; lo demás sigue al modelo', async () => {
    const db = memoryDb();
    let calls = 0, resolved = 0;
    const provider: Provider = { async chat() { calls++; return { text: 'del modelo', toolCalls: [], usage: {}, stop: 'end', assistantMsg: { role: 'assistant', content: 'del modelo' } }; } };
    const ai = new AiClient(db, config(), join(base, 'backups'), () => { resolved++; return { provider, profile: { id: 'l', label: 'L', provider: 'ollama', model: 'm' } }; });
    const r = await ai.chat('organiza Downloads');
    expect(r.opsExecuted).toBe(8);
    expect(calls).toBe(0);
    expect(resolved).toBe(0);
    expect((await ai.chat('hola')).reply).toBe('del modelo');
    expect(calls).toBe(1);
  });
});

describe('recetas de scripts y deshacer', () => {
  it('reconoce scripts por nombre con su carpeta, y no adivina lo que falta', () => {
    const c = config();
    expect(matchRecipe('duplicados en Downloads', c)).toEqual({ id: 'script', script: 'duplicados', params: { carpeta: downloads } });
    expect(matchRecipe('Corre el script de secretos en descargas', c)).toBeNull(); // frase libre: que decida el modelo
    expect(matchRecipe('busca secretos en Downloads', c)).toEqual({ id: 'script', script: 'escaner-secretos', params: { carpeta: downloads } });
    expect(matchRecipe('carpetas vacías de la carpeta Downloads', c)).toEqual({ id: 'script', script: 'carpetas-vacias', params: { carpeta: downloads } });
    expect(matchRecipe('puertos', c)).toEqual({ id: 'script', script: 'puertos', params: {} });
    expect(matchRecipe('duplicados', c)).toBeNull(); // falta la carpeta
    expect(matchRecipe('duplicados en Otra', c)).toBeNull(); // fuera de lo autorizado
    expect(matchRecipe('cerrar puerto 3000', c)).toBeNull(); // pide un dato que no hay por defecto
    expect(matchRecipe('puertos en Downloads', c)).toBeNull();
    expect(matchRecipe('deshaz eso', c)).toEqual({ id: 'undo' });
    expect(matchRecipe('deshacer', c)).toEqual({ id: 'undo' });
  });

  it('"deshaz" devuelve lo último que se pudo deshacer, sin modelo; si no hay nada, pasa al modelo', async () => {
    const db = memoryDb();
    const provider: Provider = { async chat() { return { text: 'lo vio el modelo', toolCalls: [], usage: {}, stop: 'end', assistantMsg: { role: 'assistant', content: 'x' } }; } };
    const ai = new AiClient(db, config(), join(base, 'backups'), () => ({ provider, profile: { id: 'l', label: 'L', provider: 'ollama', model: 'm' } }));
    expect((await ai.chat('deshaz eso')).reply).toBe('lo vio el modelo'); // nada que deshacer: lo atiende el modelo
    await ai.chat('organiza Downloads');
    expect(existsSync(join(downloads, 'Imágenes', 'a.png'))).toBe(true);
    const r = await ai.chat('deshaz eso');
    expect(r.reply).toMatch(/Listo, deshice «Organizar por tipo»: 8 cosas devueltas/);
    expect(existsSync(join(downloads, 'a.png'))).toBe(true);
    expect(existsSync(join(downloads, 'Imágenes', 'a.png'))).toBe(false);
    expect((await ai.chat('deshaz eso')).reply).toBe('lo vio el modelo'); // ya no queda nada
  });

  it('el modelo puede listar y ejecutar scripts de la Biblioteca como herramientas', async () => {
    const db = memoryDb();
    writeFileSync(join(downloads, 'copia.raw'), 'x'); writeFileSync(join(downloads, 'copia2.raw'), 'x');
    const reqs: any[] = []; let n = 0;
    const steps = [
      [{ id: 'a', name: 'list_scripts', input: {} }],
      [{ id: 'b', name: 'run_script', input: { id: 'duplicados', params: { carpeta: downloads } } }],
      [],
    ];
    const provider: Provider = { async chat(req) { reqs.push(JSON.parse(JSON.stringify(req))); const calls = steps[n++] ?? []; return { text: calls.length ? '' : 'listo', toolCalls: calls as any, usage: {}, stop: 'end', assistantMsg: { role: 'assistant', content: calls.map((c: any) => ({ type: 'tool_use', ...c })) } }; } };
    const ai = new AiClient(db, config(), join(base, 'backups'), () => ({ provider, profile: { id: 'l', label: 'L', provider: 'ollama', model: 'm' } }));
    const r = await ai.chat('quita los repetidos de Downloads');
    expect(r.reply).toBe('listo');
    expect(reqs[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['list_scripts', 'run_script']));
    const listed = reqs[1].messages.at(-1).content[0].content as string;
    expect(listed).toContain('duplicados — Duplicados [mueve]');
    expect(existsSync(join(downloads, 'Duplicados'))).toBe(true);
    expect(r.opsExecuted).toBeGreaterThan(0);
  });
});
