import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretStore } from '../src/main/secrets.js';
import { parseConfig } from '../src/main/config.js';

// "Cifrado" de prueba reversible (en la app real es el Llavero de macOS vía safeStorage)
const fakeCrypto = (available = true) => ({
  isAvailable: () => available,
  encrypt: (s: string) => Buffer.from(s.split('').reverse().join('') + '#enc'),
  decrypt: (b: Buffer) => b.toString().replace(/#enc$/, '').split('').reverse().join(''),
});

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentik-secrets-')); file = join(dir, 'secrets.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SecretStore', () => {
  it('guarda cifrado (nunca en claro), con permisos 600, y recupera', () => {
    const s = new SecretStore(file, fakeCrypto());
    s.set('claude', '  sk-ant-SECRETO  ');
    expect(readFileSync(file, 'utf8')).not.toContain('SECRETO');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(s.has('claude')).toBe(true);
    expect(s.get('claude')).toBe('sk-ant-SECRETO');
    expect(s.get('otro')).toBeNull();
  });

  it('sin cifrado del sistema se niega a guardar y no escribe nada', () => {
    const s = new SecretStore(file, fakeCrypto(false));
    expect(() => s.set('x', 'k')).toThrow(/no está disponible/);
    expect(existsSync(file)).toBe(false);
    expect(() => new SecretStore(file, fakeCrypto()).set('x', '   ')).toThrow(/vacía/);
  });

  it('borra una clave sin tocar las demás; un archivo corrupto no rompe', () => {
    const s = new SecretStore(file, fakeCrypto());
    s.set('a', '1'); s.set('b', '2');
    s.delete('a');
    expect(s.has('a')).toBe(false);
    expect(s.get('b')).toBe('2');
    s.delete('no-existe');
    require('node:fs').writeFileSync(file, '{{{');
    expect(s.get('b')).toBeNull();
  });
});

describe('config: modelos', () => {
  it('por defecto trae Claude Sonnet 5.5 activo', () => {
    const c = parseConfig({});
    expect(c.active_model).toBe('claude-sonnet-5-5');
    expect(c.models).toHaveLength(1);
    expect(c.models[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('acepta perfiles de Ollama y OpenAI, y si el activo no existe cae al primero', () => {
    const c = parseConfig({
      models: [
        { id: 'qwen', label: 'Qwen local', provider: 'ollama', model: 'qwen3:8b', base_url: 'http://localhost:11434', num_ctx: 8192 },
        { id: 'oa', label: 'OpenAI', provider: 'openai', model: 'gpt-4o-mini', price_in: 0.15, price_out: 0.6 },
      ],
      active_model: 'borrado',
    });
    expect(c.active_model).toBe('qwen');
    expect(c.models[1]!.price_out).toBe(0.6);
  });

  it('rechaza proveedor desconocido y URL inválida', () => {
    expect(() => parseConfig({ models: [{ id: 'x', label: 'x', provider: 'magia', model: 'm' }] })).toThrow();
    expect(() => parseConfig({ models: [{ id: 'x', label: 'x', provider: 'ollama', model: 'm', base_url: 'no es url' }] })).toThrow();
  });

  it('se pueden quitar TODOS los modelos: la lista queda vacía y no vuelve el de fábrica', () => {
    const c = parseConfig({ models: [], active_model: 'claude-sonnet-5-5' });
    expect(c.models).toEqual([]);
    expect(c.active_model).toBe('');
    expect(parseConfig({}).models).toHaveLength(1); // sin la clave "models" (config antigua) sí usa el de fábrica
  });
});
