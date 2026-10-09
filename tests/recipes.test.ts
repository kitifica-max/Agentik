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
      expect(matchRecipe(t, config()), t).toEqual({ id: 'organize', folder: downloads });
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
  it('mueve archivos solo dentro de la carpeta autorizada, con las reglas por defecto, y deja el audit', () => {
    const db = memoryDb();
    const m = matchRecipe('organiza Downloads', config())!;
    const r = runRecipe(m, db, config(), join(base, 'backups'));
    expect(r.ops).toBe(8);
    expect(r.reply).toBe('Listo, organicé Downloads: 8 archivos en 7 carpetas.');
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
    expect(audit[0]!.detail).toContain('8 movidos');
  });
  it('si no hay nada que organizar lo dice sin tocar nada', () => {
    const db = memoryDb();
    const empty = join(base, 'Vacia'); mkdirSync(empty);
    const c = { ...cfg, allowed_folders: [empty] };
    const r = runRecipe(matchRecipe('organiza Vacia', c)!, db, c, join(base, 'backups'));
    expect(r.ops).toBe(0);
    expect(r.reply).toMatch(/No encontré archivos/);
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
