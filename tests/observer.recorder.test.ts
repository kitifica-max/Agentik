import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db';
import { recordEvent } from '../src/observer/recorder';
import { cfg, countEvents, memoryDb } from './helpers';

let db: Db;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

describe('recordEvent: ningún evento excluido llega a la base', () => {
  it('descarta app excluida', () => {
    expect(recordEvent(db, cfg, { ts: 1, kind: 'app_focus', app: 'Bitwarden', title: 'x' })).toBe(false);
    expect(countEvents(db)).toBe(0);
  });

  it('descarta título sensible aunque la app no esté excluida', () => {
    recordEvent(db, cfg, { ts: 1, kind: 'app_focus', app: 'Safari', title: 'Mi contraseña' });
    expect(countEvents(db)).toBe(0);
  });

  it('descarta cambios en archivos sensibles', () => {
    recordEvent(db, cfg, { ts: 1, kind: 'file_change', path: '/proj/.env' });
    expect(countEvents(db)).toBe(0);
  });

  it('guarda eventos válidos y recorta títulos largos', () => {
    recordEvent(db, cfg, { ts: 1, kind: 'app_focus', app: 'Code', title: 'a'.repeat(500), duration_ms: 1000 });
    const row = db.prepare('SELECT title FROM events').get() as { title: string };
    expect(countEvents(db)).toBe(1);
    expect(row.title.length).toBe(200);
  });
});
