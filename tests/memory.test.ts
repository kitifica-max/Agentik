import { describe, it, expect } from 'vitest';
import { memoryDb } from './helpers.js';
import { proposeMemory, approveMemory, rejectMemory, deleteMemory, listMemories, approvedMemoriesForContext } from '../src/memory/memory.js';
import { isSensitiveText } from '../src/memory/filters.js';

describe('memory', () => {
  it('propone y aprueba recuerdo', () => {
    const db = memoryDb();
    const m = proposeMemory(db, 'Prefiero TypeScript', 'preferencia', 'chat');
    expect(m).not.toBeNull();
    expect(m!.estado).toBe('propuesto');

    const ok = approveMemory(db, m!.id);
    expect(ok).toBe(true);

    const list = listMemories(db, 'aprobado');
    expect(list).toHaveLength(1);
    expect(list[0].contenido).toBe('Prefiero TypeScript');
  });

  it('rechaza recuerdo propuesto', () => {
    const db = memoryDb();
    const m = proposeMemory(db, 'Algo temporal', 'contexto', 'chat')!;
    rejectMemory(db, m.id);
    expect(listMemories(db, 'propuesto')).toHaveLength(0);
    expect(listMemories(db, 'rechazado')).toHaveLength(1);
  });

  it('elimina recuerdo completamente', () => {
    const db = memoryDb();
    const m = proposeMemory(db, 'Borrable', 'contexto', 'chat')!;
    approveMemory(db, m.id);
    deleteMemory(db, m.id);
    expect(listMemories(db)).toHaveLength(0);
  });

  it('no propone recuerdo con dato sensible', () => {
    const db = memoryDb();
    expect(proposeMemory(db, 'Mi contraseña es 1234', 'preferencia', 'chat')).toBeNull();
    expect(proposeMemory(db, 'API_KEY=sk-abc123', 'contexto', 'chat')).toBeNull();
    expect(proposeMemory(db, 'Cuenta bancaria 12345', 'proyecto', 'chat')).toBeNull();
    expect(listMemories(db)).toHaveLength(0);
  });

  it('approvedMemoriesForContext respeta max y actualiza last_used_at', () => {
    const db = memoryDb();
    for (let i = 0; i < 5; i++) {
      const m = proposeMemory(db, `Recuerdo ${i}`, 'contexto', 'chat')!;
      approveMemory(db, m.id);
    }
    const result = approvedMemoriesForContext(db, 3);
    expect(result).toHaveLength(3);
    const after = listMemories(db, 'aprobado');
    const used = after.filter((m) => m.last_used_at !== null);
    expect(used.length).toBe(3);
  });
});

describe('isSensitiveText', () => {
  it('detecta contraseñas', () => expect(isSensitiveText('mi contraseña es abc')).toBe(true));
  it('detecta tarjetas de crédito', () => expect(isSensitiveText('tarjeta de crédito 4111-1111-1111-1111')).toBe(true));
  it('detecta datos bancarios', () => expect(isSensitiveText('mi banco principal')).toBe(true));
  it('detecta salud', () => expect(isSensitiveText('diagnóstico médico')).toBe(true));
  it('detecta API keys', () => expect(isSensitiveText('api_key=sk-test')).toBe(true));
  it('pasa texto normal', () => expect(isSensitiveText('Prefiero usar React para la UI')).toBe(false));
});
