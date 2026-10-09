import { describe, it, expect } from 'vitest';
import { memoryDb } from './helpers.js';
import {
  saveExchange, loadHistory, modelContext, clearHistory, historyCount, listConversations, newConversation, openConversation,
  deleteConversation, setPinned, activeConversation, titleFrom, MAX_CONVERSATIONS,
} from '../src/chat/history.js';

const say = (db: ReturnType<typeof memoryDb>, text: string) => saveExchange(db, text, `re: ${text}`, 'ai');

describe('conversaciones', () => {
  it('crea una al primer mensaje, con título del primer mensaje (sin claves, acotado)', () => {
    const db = memoryDb();
    say(db, 'organiza mi carpeta de descargas por tipo y fecha, por favor, con calma y sin prisa');
    const l = listConversations(db);
    expect(l.items).toHaveLength(1);
    expect(l.items[0]!.title.length).toBeLessThanOrEqual(40);
    expect(l.items[0]!.title.endsWith('…')).toBe(true);
    expect(l.items[0]!.messages).toBe(2);
    expect(titleFrom('mi clave es sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toContain('[clave oculta]');
  });

  it('cada conversación tiene su propio historial y su propio contexto para el modelo', () => {
    const db = memoryDb();
    say(db, 'tema uno');
    const a = activeConversation(db);
    const n = newConversation(db) as { id: number };
    expect(n.id).not.toBe(a);
    say(db, 'tema dos');
    expect(loadHistory(db).map((m) => m.content)).toEqual(['tema dos', 're: tema dos']);
    expect(modelContext(db).map((m) => m.content)).toEqual(['tema dos', 're: tema dos']);
    expect(openConversation(db, a)).toBe(true);
    expect(loadHistory(db).map((m) => m.content)).toEqual(['tema uno', 're: tema uno']);
    expect(openConversation(db, 9999)).toBe(false);
  });

  it('"nueva" no apila conversaciones vacías: reutiliza la que ya está vacía', () => {
    const db = memoryDb();
    say(db, 'hola');
    const a = newConversation(db) as { id: number };
    const b = newConversation(db) as { id: number };
    expect(b.id).toBe(a.id);
    expect(listConversations(db).items).toHaveLength(2);
  });

  it(`con ${MAX_CONVERSATIONS} chats, crear otro borra la más vieja sin fijar y respeta las fijadas`, () => {
    const db = memoryDb();
    const ids: number[] = [];
    for (let i = 0; i < MAX_CONVERSATIONS; i++) {
      if (i > 0) newConversation(db, 1000 + i);
      say(db, `chat ${i}`);
      ids.push(activeConversation(db));
    }
    expect(listConversations(db).items).toHaveLength(MAX_CONVERSATIONS);
    setPinned(db, ids[0]!, true); // la más vieja, fijada
    const r = newConversation(db) as { id: number; evicted: number };
    expect(r.evicted).toBe(1);
    const left = listConversations(db).items.map((c) => c.id);
    expect(left).toHaveLength(MAX_CONVERSATIONS);
    expect(left).toContain(ids[0]); // fijada: sigue
    expect(left).not.toContain(ids[1]); // la siguiente más vieja: se fue
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?').get(ids[1]!)).toEqual({ n: 0 }); // y sus mensajes también
  });

  it('si todas están fijadas no borra nada y lo dice', () => {
    const db = memoryDb();
    for (let i = 0; i < MAX_CONVERSATIONS; i++) { if (i > 0) newConversation(db); say(db, `c${i}`); setPinned(db, activeConversation(db), true); }
    expect(newConversation(db)).toEqual({ error: 'all-pinned' });
    expect(listConversations(db).items).toHaveLength(MAX_CONVERSATIONS);
  });

  it('las fijadas van primero; borrar la activa pasa a la más reciente; borrar la última deja una vacía', () => {
    const db = memoryDb();
    say(db, 'vieja'); const a = activeConversation(db);
    newConversation(db, Date.now() + 10); say(db, 'media'); const b = activeConversation(db);
    newConversation(db, Date.now() + 20); say(db, 'reciente'); const c = activeConversation(db);
    setPinned(db, a, true);
    expect(listConversations(db).items.map((x) => x.id)).toEqual([a, c, b]);
    expect(deleteConversation(db, c)).toBe(true);
    expect(activeConversation(db)).toBe(b); // la de actividad más reciente que queda
    expect(deleteConversation(db, 9999)).toBe(false);
    deleteConversation(db, a); deleteConversation(db, b);
    expect(listConversations(db).items).toHaveLength(1);
    expect(loadHistory(db)).toEqual([]);
  });

  it('adopta los mensajes de antes de que existieran las conversaciones', () => {
    const db = memoryDb();
    db.prepare("INSERT INTO chat_messages (ts, role, content, kind) VALUES (1, 'user', 'mensaje viejo', 'ai'), (2, 'assistant', 'respuesta vieja', 'ai')").run();
    expect(loadHistory(db).map((m) => m.content)).toEqual(['mensaje viejo', 'respuesta vieja']);
    expect(listConversations(db).items[0]!.title).toBe('mensaje viejo');
  });

  it('borrar todo elimina todas las conversaciones y mensajes', () => {
    const db = memoryDb();
    say(db, 'uno'); newConversation(db); say(db, 'dos');
    expect(clearHistory(db)).toBe(4);
    expect(historyCount(db)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 0 });
    say(db, 'otra vez'); // y se puede seguir usando
    expect(listConversations(db).items).toHaveLength(1);
  });

  it('el tope de 500 mensajes no deja conversaciones vacías (salvo la activa y las fijadas)', () => {
    const db = memoryDb();
    say(db, 'primera'); newConversation(db);
    for (let i = 0; i < 260; i++) say(db, `m${i}`);
    expect(historyCount(db)).toBeLessThanOrEqual(500);
    expect(listConversations(db).items).toHaveLength(1);
  });
});
