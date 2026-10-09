import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb, cfg } from './helpers.js';
import { openDb } from '../src/db/db.js';
import { saveExchange, loadHistory, modelContext, clearHistory, historyCount, redactSecrets, MAX_STORED } from '../src/chat/history.js';
import { abortable } from '../src/chat/abort.js';
import { runCommand } from '../src/shell/shell.js';
import { AiClient } from '../src/ai/client.js';
import { OpenAiProvider, AnthropicProvider, type Provider, type ChatRequest, type LlmResult } from '../src/ai/providers.js';
import type { ModelProfile } from '../src/shared/types.js';

describe('historial del chat', () => {
  it('guarda en orden, con rol y tipo, y lo devuelve igual al reabrir', () => {
    const db = memoryDb();
    saveExchange(db, 'hola', 'Hola, ¿qué hacemos?', 'ai', 1000);
    saveExchange(db, 'resumen', 'Resumen de hoy…', 'local', 2000);
    saveExchange(db, null, 'Sugerencia aceptada', 'ai', 3000); // solo respuesta
    const h = loadHistory(db);
    expect(h.map((m) => [m.role, m.content, m.kind])).toEqual([
      ['user', 'hola', 'ai'], ['assistant', 'Hola, ¿qué hacemos?', 'ai'],
      ['user', 'resumen', 'local'], ['assistant', 'Resumen de hoy…', 'local'],
      ['assistant', 'Sugerencia aceptada', 'ai'],
    ]);
  });

  it('al reabrir, el modelo solo recupera lo que pasó por él (no comandos locales ni errores)', () => {
    const db = memoryDb();
    saveExchange(db, 'organiza', 'Listo', 'ai');
    saveExchange(db, 'espacio', 'Tienes 3 GB libres', 'local');
    saveExchange(db, 'otra', 'Error: falta la clave', 'error');
    saveExchange(db, 'más', 'Detenido.', 'stopped');
    expect(modelContext(db).map((m) => m.content)).toEqual(['organiza', 'Listo']);
    for (let i = 0; i < 40; i++) saveExchange(db, `u${i}`, `a${i}`, 'ai');
    const ctx = modelContext(db, 30);
    expect(ctx).toHaveLength(30);
    expect(ctx.at(-1)!.content).toBe('a39'); // los más recientes, en orden
  });

  it('no guarda claves pegadas por error', () => {
    const db = memoryDb();
    saveExchange(db, 'mi clave es sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 y ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ok', 'ai');
    saveExchange(db, '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'ok', 'ai');
    const all = loadHistory(db).map((m) => m.content).join('\n');
    expect(all).not.toMatch(/sk-ant|ghp_|MIIEow|BEGIN/);
    expect(all).toContain('[clave oculta]');
    expect(redactSecrets('texto normal sin claves')).toBe('texto normal sin claves');
  });

  it(`conserva como máximo ${MAX_STORED} mensajes (descarta los más viejos)`, () => {
    const db = memoryDb();
    for (let i = 0; i < 300; i++) saveExchange(db, `u${i}`, `a${i}`, 'ai');
    expect(historyCount(db)).toBe(MAX_STORED);
    const h = loadHistory(db, 1000);
    expect(h[0]!.content).toBe('u50'); // los 100 primeros se fueron
    expect(h.at(-1)!.content).toBe('a299');
  });

  describe('borrado real', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentik-hist-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('al borrar no queda rastro en el archivo de la base ni en su registro (WAL)', () => {
      const file = join(dir, 'agentik.db');
      const db = openDb(file);
      const SECRETO = 'FRASE-MUY-PRIVADA-' + 'x'.repeat(40);
      saveExchange(db, `cuéntame de ${SECRETO}`, `claro, ${SECRETO}`, 'ai');
      expect(historyCount(db)).toBe(2);
      expect(clearHistory(db)).toBe(2);
      expect(historyCount(db)).toBe(0);
      expect(loadHistory(db)).toEqual([]);
      db.close();
      for (const f of readdirSync(dir)) {
        expect(readFileSync(join(dir, f)).includes(SECRETO), `${f} aún contiene el texto borrado`).toBe(false);
      }
    });
  });
});

describe('detener', () => {
  it('abortable: resuelve normal, se corta al abortar y no se queda escuchando', async () => {
    const a = new AbortController();
    expect(await abortable(Promise.resolve(7), a.signal)).toBe(7);
    const b = new AbortController();
    const slow = new Promise<number>((r) => setTimeout(() => r(1), 200));
    const p = abortable(slow, b.signal);
    setTimeout(() => b.abort(), 20);
    await expect(p).rejects.toThrow('aborted');
    const c = new AbortController(); c.abort();
    await expect(abortable(Promise.resolve(1), c.signal)).rejects.toThrow('aborted');
  });

  it('runCommand: abortar mata el comando y todo lo que lanzó, de inmediato', async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const p = runCommand('sleep 30', { cwd: '/tmp', timeoutMs: 60_000, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 150);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    const already = new AbortController(); already.abort();
    expect((await runCommand('sleep 30', { cwd: '/tmp', timeoutMs: 60_000, signal: already.signal })).aborted).toBe(true);
  });

  it('los proveedores reenvían la señal y cortan la petición', async () => {
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = (_u: string, init: any) => new Promise<any>((_res, rej) => {
      seen = init.signal;
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const profile: ModelProfile = { id: 'o', label: 'o', provider: 'openai', model: 'm' };
    const p = new OpenAiProvider(profile, 'k', fetchImpl as any).chat({ system: 's', tools: [], messages: [], maxTokens: 1, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen!.aborted).toBe(true);

    let opts: any;
    const client = { messages: { create: async (_b: unknown, o: unknown) => { opts = o; return { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: {} }; } } };
    await new AnthropicProvider('m', 'k', client as any).chat({ system: 's', tools: [], messages: [], maxTokens: 1, signal: ctrl.signal });
    expect(opts.signal).toBe(ctrl.signal);
  });
});

describe('el agente se detiene', () => {
  const local: ModelProfile = { id: 'l', label: 'L', provider: 'ollama', model: 'q' };
  const usage = { input_tokens: 1, output_tokens: 1 };
  const step = (text: string, calls: LlmResult['toolCalls'] = []): LlmResult => ({
    text, toolCalls: calls, usage, stop: calls.length ? 'tool_use' : 'end',
    assistantMsg: { role: 'assistant', content: [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map((c) => ({ type: 'tool_use' as const, ...c }))] },
  });
  let base: string, allowed: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'agentik-stop-')); allowed = join(base, 'a'); mkdirSync(allowed); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const client = (provider: Provider) => new AiClient(memoryDb(), { ...cfg, allowed_folders: [allowed], memory_enabled: false }, join(base, 'b'), () => ({ provider, profile: local }));

  it('Detener durante la llamada al modelo: corta y responde "Detenido." sin tratarlo como error', async () => {
    const ctrl = new AbortController();
    let got: AbortSignal | undefined;
    const provider: Provider = { chat: (req: ChatRequest) => new Promise((_res, rej) => {
      got = req.signal;
      req.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }) };
    const p = client(provider).chat('hazlo', ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    const r = await p;
    expect(r.stopped).toBe(true);
    expect(r.reply).toBe('Detenido.');
    expect(got).toBe(ctrl.signal);
  });

  it('Detener con un comando corriendo: lo mata, no arranca la siguiente herramienta y cuenta lo que sí se hizo', async () => {
    const ctrl = new AbortController();
    const provider: Provider = { chat: async () => step('', [
      { id: '1', name: 'create_folder', input: { path: join(allowed, 'antes') } },
      { id: '2', name: 'run_command', input: { command: 'sleep 30', cwd: allowed, timeout_seconds: 60 } },
      { id: '3', name: 'create_folder', input: { path: join(allowed, 'despues') } },
    ]) };
    const t0 = Date.now();
    const p = client(provider).chat('haz cosas', ctrl.signal);
    setTimeout(() => ctrl.abort(), 300);
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(5000); // no esperó los 30 s
    expect(r.stopped).toBe(true);
    expect(existsSync(join(allowed, 'antes'))).toBe(true); // lo ya hecho queda
    expect(existsSync(join(allowed, 'despues'))).toBe(false); // lo que seguía no corre
    expect(r.reply).toContain('Alcancé a ejecutar 1 operación');
    expect(r.opsExecuted).toBe(1);
  });

  it('con la señal ya abortada ni siquiera llama al modelo', async () => {
    const ctrl = new AbortController(); ctrl.abort();
    let calls = 0;
    const r = await client({ chat: async () => { calls++; return step('x'); } }).chat('hola', ctrl.signal);
    expect(r.stopped).toBe(true);
    expect(calls).toBe(0);
  });

  it('tras detener, la conversación sigue funcionando y recuerda lo anterior', async () => {
    const seen: ChatRequest[] = [];
    const ai = client({ chat: async (req) => { seen.push(JSON.parse(JSON.stringify(req))); return step('listo'); } });
    const ctrl = new AbortController(); ctrl.abort();
    await ai.chat('uno', ctrl.signal);
    expect((await ai.chat('dos')).reply).toBe('listo');
    expect(seen[0]!.messages.map((m) => m.content)).toEqual(['uno', 'Detenido.', 'dos']);
  });

  it('loadHistory: al reabrir, el modelo retoma la conversación guardada', async () => {
    const seen: ChatRequest[] = [];
    const ai = client({ chat: async (req) => { seen.push(JSON.parse(JSON.stringify(req))); return step('claro'); } });
    ai.loadHistory([{ role: 'user', content: 'mi proyecto es Kogn' }, { role: 'assistant', content: 'anotado' }]);
    await ai.chat('¿cuál es mi proyecto?');
    expect(seen[0]!.messages.map((m) => m.content)).toEqual(['mi proyecto es Kogn', 'anotado', '¿cuál es mi proyecto?']);
  });
});
