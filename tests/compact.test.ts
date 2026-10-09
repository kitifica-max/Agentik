import { describe, it, expect } from 'vitest';
import { compactToolResults } from '../src/ai/compact.js';
import type { Msg } from '../src/ai/providers.js';

const use = (id: string, name: string): Msg => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] });
const res = (id: string, content: string, is_error = false): Msg => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] });

describe('compactToolResults', () => {
  const names = new Map([['a', 'list_folder'], ['b', 'run_command'], ['c', 'read_file']]);
  const build = (): Msg[] => [
    { role: 'user', content: 'haz cosas' },
    use('a', 'list_folder'), res('a', 'x'.repeat(5000)),
    use('b', 'run_command'), res('b', 'falló', true),
    use('c', 'read_file'), res('c', 'contenido completo'),
  ];

  it('compacta los grupos viejos y conserva completo el último', () => {
    const m = build();
    compactToolResults(m, names);
    expect((m[2]!.content as any)[0].content).toBe('[resultado previo: list_folder → 5000 bytes, ok]');
    expect((m[4]!.content as any)[0].content).toBe('[resultado previo: run_command → 6 bytes, error]');
    expect((m[6]!.content as any)[0].content).toBe('contenido completo');
  });

  it('cada tool_use conserva su tool_result emparejado (mismo id, mismo orden)', () => {
    const m = build();
    compactToolResults(m, names);
    const uses = m.flatMap((x) => (Array.isArray(x.content) ? x.content.filter((b) => b.type === 'tool_use').map((b: any) => b.id) : []));
    const results = m.flatMap((x) => (Array.isArray(x.content) ? x.content.filter((b) => b.type === 'tool_result').map((b: any) => b.tool_use_id) : []));
    expect(results).toEqual(uses);
    expect(m).toHaveLength(7);
  });

  it('es idempotente, y no toca nada si solo hay un grupo de resultados', () => {
    const m = build();
    compactToolResults(m, names);
    const once = JSON.stringify(m);
    compactToolResults(m, names);
    expect(JSON.stringify(m)).toBe(once);
    const single: Msg[] = [use('a', 'x'), res('a', 'datos')];
    compactToolResults(single, names);
    expect((single[1]!.content as any)[0].content).toBe('datos');
  });

  it('no modifica los mensajes de texto del usuario (aunque se parezcan)', () => {
    const m: Msg[] = [{ role: 'user', content: 'hola' }, use('a', 'x'), res('a', 'r1'), use('b', 'x'), res('b', 'r2')];
    compactToolResults(m, names);
    expect(m[0]!.content).toBe('hola');
  });
});
