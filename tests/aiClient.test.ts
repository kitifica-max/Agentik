import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb, cfg } from './helpers.js';
import { AiClient } from '../src/ai/client.js';
import { usageTotals } from '../src/ai/cost.js';
import type { Provider, ChatRequest, LlmResult } from '../src/ai/providers.js';
import type { ModelProfile } from '../src/shared/types.js';

const local: ModelProfile = { id: 'l', label: 'Local', provider: 'ollama', model: 'qwen3:8b' };
const paid: ModelProfile = { id: 'p', label: 'Pago', provider: 'openai', model: 'gpt-x', price_in: 1, price_out: 2 };

const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
const step = (text: string, calls: LlmResult['toolCalls'] = []): LlmResult => ({
  text, toolCalls: calls, usage, stop: calls.length ? 'tool_use' : 'end',
  assistantMsg: { role: 'assistant', content: [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map((c) => ({ type: 'tool_use' as const, ...c }))] },
});

// Proveedor simulado: responde en orden y guarda lo que recibió
function script(results: LlmResult[]): { provider: Provider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return { requests, provider: { async chat(req) { requests.push(JSON.parse(JSON.stringify(req))); return results[Math.min(i++, results.length - 1)]!; } } };
}

let base: string, allowed: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'agentik-ai-')); allowed = join(base, 'allowed'); mkdirSync(allowed); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

function client(db: ReturnType<typeof memoryDb>, resolve: () => { provider: Provider; profile: ModelProfile }) {
  return new AiClient(db, { ...cfg, allowed_folders: [allowed], memory_enabled: false }, join(base, 'backups'), resolve);
}

describe('bucle del agente con cualquier proveedor', () => {
  it('ejecuta herramientas, devuelve los resultados al modelo y responde con el texto de la última ronda', async () => {
    const db = memoryDb();
    const { provider, requests } = script([
      step('Voy a crear la carpeta', [{ id: 'c1', name: 'create_folder', input: { path: join(allowed, 'Fotos') } }]),
      step('Listo, creé Fotos'),
    ]);
    const r = await client(db, () => ({ provider, profile: local })).chat('crea Fotos');
    expect(existsSync(join(allowed, 'Fotos'))).toBe(true);
    expect(r.reply).toBe('Listo, creé Fotos');
    expect(r.opsExecuted).toBe(1);
    // la 2ª llamada lleva el mensaje del asistente y el resultado de la herramienta
    const msgs = requests[1]!.messages;
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: false }] });
    expect(requests[0]!.tools.map((t) => t.name)).toContain('organize_folder');
    expect(requests[0]!.system).toContain('Agentik');
  });

  it('los errores de herramienta vuelven al modelo sin romper el bucle (rutas sensibles, argumentos faltantes, herramientas inventadas)', async () => {
    const db = memoryDb();
    writeFileSync(join(allowed, '.env'), 'SECRETO=1');
    const { provider, requests } = script([
      step('', [
        { id: 'a', name: 'write_file', input: { path: join(allowed, '.env'), content: 'x' } },
        { id: 'b', name: 'create_folder', input: {} },
        { id: 'c', name: 'volar', input: {} },
      ]),
      step('No pude hacerlo'),
    ]);
    const r = await client(db, () => ({ provider, profile: local })).chat('haz cosas');
    const results = (requests[1]!.messages.at(-1)!.content as any[]);
    expect(results.map((x) => x.is_error)).toEqual([true, true, true]);
    expect(results[0].content).toMatch(/sensible/i);
    expect(r.opsExecuted).toBe(0);
    expect(r.reply).toBe('No pude hacerlo');
  });

  it('resuelve el modelo en CADA mensaje: cambiar de modelo surte efecto de inmediato', async () => {
    const db = memoryDb();
    const a = script([step('respuesta A')]);
    const b = script([step('respuesta B')]);
    let active: 'a' | 'b' = 'a';
    const ai = client(db, () => (active === 'a' ? { provider: a.provider, profile: local } : { provider: b.provider, profile: paid }));
    expect((await ai.chat('hola')).reply).toBe('respuesta A');
    active = 'b';
    expect((await ai.chat('hola otra vez')).reply).toBe('respuesta B');
    expect(b.requests[0]!.messages.map((m) => m.content)).toContain('hola'); // el historial de texto se conserva
  });

  it('registra el costo con el precio del perfil: local $0, de pago según su tarifa', async () => {
    const db = memoryDb();
    await client(db, () => ({ provider: script([step('ok')]).provider, profile: local })).chat('x');
    expect(usageTotals(db).today).toBe(0);
    await client(db, () => ({ provider: script([step('ok')]).provider, profile: paid })).chat('x');
    expect(usageTotals(db).today).toBeCloseTo(3); // 1M entrada × $1 + 1M salida × $2
    const rows = db.prepare('SELECT model FROM usage ORDER BY id').all() as { model: string }[];
    expect(rows.map((r) => r.model)).toEqual(['qwen3:8b', 'gpt-x']);
  });

  it('si el proveedor falla (p. ej. falta la clave), el error llega tal cual al llamador', async () => {
    const db = memoryDb();
    const ai = client(db, () => { throw new Error('Falta la API key de "Claude". Agrégala en la pestaña Modelo.'); });
    await expect(ai.chat('hola')).rejects.toThrow(/pestaña Modelo/);
  });

  it('el bloque estático del system es idéntico entre llamadas aunque cambie lo dinámico (cacheable)', async () => {
    const db = memoryDb();
    const a = script([step('uno')]);
    const ai = new AiClient(db, { ...cfg, allowed_folders: [allowed], memory_enabled: false }, join(base, 'backups'), () => ({ provider: a.provider, profile: local }));
    await ai.chat('hola');
    writeFileSync(join(allowed, 'nuevo.txt'), 'x'); // cambia el listado de carpetas (dinámico)
    await ai.chat('otra vez');
    const [r1, r2] = a.requests;
    expect(r1!.systemParts!.static).toBe(r2!.systemParts!.static);
    expect(r1!.systemParts!.static).toContain('Agentik');
    expect(r1!.systemParts!.dynamic).not.toBe(r2!.systemParts!.dynamic);
    expect(r1!.system).toBe(r1!.systemParts!.static + '\n\n' + r1!.systemParts!.dynamic);
    expect(JSON.stringify(r1!.tools)).toBe(JSON.stringify(r2!.tools));
  });

  it('se detiene en el límite de rondas y lo avisa', async () => {
    const db = memoryDb();
    const loop = step('', [{ id: 'x', name: 'list_folder', input: { path: allowed } }]);
    const r = await client(db, () => ({ provider: script([loop]).provider, profile: local })).chat('sin fin');
    expect(r.reply).toMatch(/límite de \d+ rondas/);
  });
});
