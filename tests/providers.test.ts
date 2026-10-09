import { describe, it, expect } from 'vitest';
import {
  OpenAiProvider, OllamaProvider, AnthropicProvider, createProvider, listOllamaModels,
  toOpenAiMessages, toOllamaMessages, type FetchLike, type Msg, type ToolDef,
} from '../src/ai/providers.js';
import type { ModelProfile } from '../src/shared/types.js';

const TOOLS: ToolDef[] = [{ name: 'create_folder', description: 'Crear carpeta', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

// fetch falso: guarda la petición y responde lo que se le indique
function fakeFetch(reply: { status?: number; body: unknown } | (() => never)) {
  const calls: { url: string; init: any }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (typeof reply === 'function') reply();
    const r = reply as { status?: number; body: unknown };
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { impl, calls };
}

const history: Msg[] = [
  { role: 'user', content: 'crea la carpeta Fotos' },
  { role: 'assistant', content: [{ type: 'text', text: 'Voy' }, { type: 'tool_use', id: 'c1', name: 'create_folder', input: { path: '/x/Fotos' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'OK: crear' }] },
];

describe('compatible con OpenAI', () => {
  const profile: ModelProfile = { id: 'oa', label: 'OA', provider: 'openai', model: 'gpt-x', base_url: 'https://api.example.com/v1/' };

  it('convierte mensajes y herramientas al formato chat/completions', () => {
    const m = toOpenAiMessages('SYS', history) as any[];
    expect(m[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(m[2].tool_calls[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'create_folder', arguments: '{"path":"/x/Fotos"}' } });
    expect(m[2].content).toBe('Voy');
    expect(m[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'OK: crear' });
  });

  it('envía clave solo como Bearer, a la URL del perfil, y parsea llamadas, uso y fin', async () => {
    const { impl, calls } = fakeFetch({ body: {
      choices: [{ finish_reason: 'tool_calls', message: { content: '<think>pienso</think>Listo', tool_calls: [{ id: 'z9', function: { name: 'create_folder', arguments: '{"path":"/x/A"}' } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    } });
    const r = await new OpenAiProvider(profile, 'sk-secreto', impl).chat({ system: 'S', tools: TOOLS, messages: history, maxTokens: 500 });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0]!.init.headers.authorization).toBe('Bearer sk-secreto');
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'create_folder', description: 'Crear carpeta', parameters: TOOLS[0]!.input_schema } });
    expect(body.max_tokens).toBe(500);
    expect(r.text).toBe('Listo'); // sin <think>
    expect(r.toolCalls).toEqual([{ id: 'z9', name: 'create_folder', input: { path: '/x/A' } }]);
    expect(r.stop).toBe('tool_use');
    expect(r.usage).toEqual({ input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40 });
    expect(r.assistantMsg.content).toEqual([{ type: 'text', text: 'Listo' }, { type: 'tool_use', id: 'z9', name: 'create_folder', input: { path: '/x/A' } }]);
  });

  it('sin clave no manda Authorization; argumentos rotos → {}; length → max_tokens; error HTTP no filtra la clave', async () => {
    const a = fakeFetch({ body: { choices: [{ finish_reason: 'length', message: { content: 'cortado', tool_calls: [] } }] } });
    const r = await new OpenAiProvider(profile, undefined, a.impl).chat({ system: 'S', tools: [], messages: [], maxTokens: 1 });
    expect(a.calls[0]!.init.headers.authorization).toBeUndefined();
    expect(r.stop).toBe('max_tokens');

    const b = fakeFetch({ body: { choices: [{ message: { tool_calls: [{ id: 'k', function: { name: 'create_folder', arguments: '{roto' } }] } }] } });
    const rb = await new OpenAiProvider(profile, 'k', b.impl).chat({ system: 'S', tools: TOOLS, messages: [], maxTokens: 1 });
    expect(rb.toolCalls[0]!.input).toEqual({});

    const c = fakeFetch({ status: 401, body: { error: 'bad key' } });
    await expect(new OpenAiProvider(profile, 'sk-secreto', c.impl).chat({ system: 'S', tools: [], messages: [], maxTokens: 1 }))
      .rejects.toThrow(/^401 /);
    await new OpenAiProvider(profile, 'sk-secreto', c.impl).chat({ system: 'S', tools: [], messages: [], maxTokens: 1 })
      .catch((e: Error) => expect(e.message).not.toContain('sk-secreto'));
  });
});

describe('Ollama (API nativa)', () => {
  const profile: ModelProfile = { id: 'ol', label: 'Local', provider: 'ollama', model: 'qwen3:8b' };

  it('los resultados de herramienta llevan tool_name y los argumentos van como objeto', () => {
    const m = toOllamaMessages('SYS', history) as any[];
    expect(m[2].tool_calls[0]).toEqual({ function: { name: 'create_folder', arguments: { path: '/x/Fotos' } } });
    expect(m[3]).toEqual({ role: 'tool', tool_name: 'create_folder', content: 'OK: crear' });
  });

  it('usa /api/chat sin stream, fija num_ctx (8192 por defecto o el del perfil) y parsea la respuesta', async () => {
    const { impl, calls } = fakeFetch({ body: {
      message: { role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'create_folder', arguments: { path: '/x/B' } } }, { function: { name: 'create_folder', arguments: { path: '/x/C' } } }] },
      done: true, prompt_eval_count: 321, eval_count: 45,
    } });
    const r = await new OllamaProvider({ ...profile, base_url: 'http://127.0.0.1:11434/' }, impl).chat({ system: 'S', tools: TOOLS, messages: history, maxTokens: 700 });
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]!.init.headers.authorization).toBeUndefined();
    const body = JSON.parse(calls[0]!.init.body);
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: false, options: { num_ctx: 8192, num_predict: 700 } });
    expect(r.toolCalls.map((c) => c.input)).toEqual([{ path: '/x/B' }, { path: '/x/C' }]);
    expect(new Set(r.toolCalls.map((c) => c.id)).size).toBe(2); // ids únicos aunque Ollama no los da
    expect(r.usage).toEqual({ input_tokens: 321, output_tokens: 45 });

    const c = fakeFetch({ body: { message: { content: 'x' }, done_reason: 'length' } });
    const r2 = await new OllamaProvider({ ...profile, num_ctx: 16384 }, c.impl).chat({ system: 'S', tools: [], messages: [], maxTokens: 1 });
    expect(JSON.parse(c.calls[0]!.init.body).options.num_ctx).toBe(16384);
    expect(r2.stop).toBe('max_tokens');
  });

  it('gpt-oss: el razonamiento (thinking) se conserva y se reenvía en el turno siguiente; OpenAI-compat no lo manda', async () => {
    const { impl } = fakeFetch({ body: { message: { role: 'assistant', content: '', thinking: 'Debo crear la carpeta', tool_calls: [{ function: { name: 'create_folder', arguments: { path: '/x/G' } } }] }, done: true } });
    const r = await new OllamaProvider({ ...profile, model: 'gpt-oss:20b' }, impl).chat({ system: 'S', tools: TOOLS, messages: [{ role: 'user', content: 'crea G' }], maxTokens: 50 });
    expect(r.text).toBe(''); // el razonamiento NO se muestra como respuesta
    expect(r.assistantMsg.content).toEqual([{ type: 'thinking', thinking: 'Debo crear la carpeta' }, { type: 'tool_use', id: r.toolCalls[0]!.id, name: 'create_folder', input: { path: '/x/G' } }]);

    const next: Msg[] = [{ role: 'user', content: 'crea G' }, r.assistantMsg, { role: 'user', content: [{ type: 'tool_result', tool_use_id: r.toolCalls[0]!.id, content: 'OK' }] }];
    const sent = toOllamaMessages('S', next) as any[];
    expect(sent[2]).toMatchObject({ role: 'assistant', thinking: 'Debo crear la carpeta', tool_calls: [{ function: { name: 'create_folder' } }] });
    expect(sent[3]).toEqual({ role: 'tool', tool_name: 'create_folder', content: 'OK' });
    expect(JSON.stringify(toOpenAiMessages('S', next))).not.toContain('Debo crear');
    // sin razonamiento no se agrega el campo
    expect((toOllamaMessages('S', history) as any[])[2]).not.toHaveProperty('thinking');
  });

  it('errores claros: sin soporte de herramientas, modelo no descargado, Ollama cerrado', async () => {
    const run = (r: Parameters<typeof fakeFetch>[0]) => new OllamaProvider(profile, fakeFetch(r).impl).chat({ system: 'S', tools: TOOLS, messages: [], maxTokens: 1 });
    await expect(run({ status: 400, body: '{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}' })).rejects.toThrow(/no soporta herramientas/);
    await expect(run({ status: 404, body: '{"error":"model not found"}' })).rejects.toThrow(/ollama pull qwen3:8b/);
    await expect(run(() => { throw new TypeError('fetch failed'); })).rejects.toThrow(/No pude conectar con Ollama/);
  });

  it('lista los modelos instalados', async () => {
    const { impl, calls } = fakeFetch({ body: { models: [{ name: 'qwen3:8b' }, { name: 'llama3.1:8b' }] } });
    expect(await listOllamaModels('http://localhost:11434/', impl)).toEqual(['qwen3:8b', 'llama3.1:8b']);
    expect(calls[0]!.url).toBe('http://localhost:11434/api/tags');
  });
});

describe('Anthropic y fábrica', () => {
  it('conserva el mensaje del asistente tal cual (incluye bloques de razonamiento)', async () => {
    const content = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'hola' }, { type: 'tool_use', id: 't1', name: 'create_folder', input: { path: '/x' } }];
    const client = { messages: { create: async () => ({ content, stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 4 } }) } };
    const r = await new AnthropicProvider('claude-x', 'k', client as any).chat({ system: 'S', tools: TOOLS, messages: [], maxTokens: 10 });
    expect(r.text).toBe('hola');
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'create_folder', input: { path: '/x' } }]);
    expect(r.assistantMsg.content).toBe(content);
    expect(r.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
  });

  it('caché de prompt: system en bloques (estático con cache_control, dinámico sin él) y cache_control en la última herramienta', async () => {
    let params: any;
    const client = { messages: { create: async (p: any) => { params = p; return { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }; } } };
    const tools: ToolDef[] = [TOOLS[0]!, { ...TOOLS[0]!, name: 'otra' }];
    await new AnthropicProvider('claude-x', 'k', client as any).chat({ system: 'EST\n\nDIN', systemParts: { static: 'EST', dynamic: 'DIN' }, tools, messages: [], maxTokens: 10 });
    expect(params.system).toEqual([{ type: 'text', text: 'EST', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'DIN' }]);
    expect(params.tools[0].cache_control).toBeUndefined();
    expect(params.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(tools[1]!.cache_control).toBeUndefined(); // no muta la definición original
    // sin parte dinámica: un solo bloque
    await new AnthropicProvider('claude-x', 'k', client as any).chat({ system: 'EST', systemParts: { static: 'EST', dynamic: '' }, tools: [], messages: [], maxTokens: 10 });
    expect(params.system).toHaveLength(1);
    // sin systemParts sigue siendo un string
    await new AnthropicProvider('claude-x', 'k', client as any).chat({ system: 'S', tools: [], messages: [], maxTokens: 10 });
    expect(params.system).toBe('S');
  });

  it('OpenAI y Ollama usan el texto completo (system) aunque lleguen systemParts', async () => {
    const f = fakeFetch({ body: { choices: [{ message: { content: 'x' } }] } });
    const p: ModelProfile = { id: 'o', label: 'o', provider: 'openai', model: 'm' };
    await new OpenAiProvider(p, undefined, f.impl).chat({ system: 'EST\n\nDIN', systemParts: { static: 'EST', dynamic: 'DIN' }, tools: [], messages: [], maxTokens: 5 });
    expect(JSON.parse(f.calls[0]!.init.body).messages[0]).toEqual({ role: 'system', content: 'EST\n\nDIN' });
  });

  it('la fábrica elige el proveedor; Anthropic sin clave da un error accionable', () => {
    const base = { id: 'a', label: 'Claude', model: 'm' } as const;
    expect(createProvider({ ...base, provider: 'ollama' }, undefined)).toBeInstanceOf(OllamaProvider);
    expect(createProvider({ ...base, provider: 'openai' }, undefined)).toBeInstanceOf(OpenAiProvider);
    expect(createProvider({ ...base, provider: 'anthropic' }, 'k')).toBeInstanceOf(AnthropicProvider);
    expect(() => createProvider({ ...base, provider: 'anthropic' }, undefined)).toThrow(/pestaña Modelo/);
  });
});
