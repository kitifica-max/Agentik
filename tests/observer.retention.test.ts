import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db';
import { purgeExpired } from '../src/observer/retention';
import { countEvents, memoryDb } from './helpers';

const HOUR = 3_600_000;
let db: Db;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

describe('retención', () => {
  it('elimina eventos vencidos y conserva los vigentes', () => {
    const now = 100 * HOUR;
    const ins = db.prepare('INSERT INTO events (ts, kind, app) VALUES (?, ?, ?)');
    ins.run(now - 25 * HOUR, 'app_focus', 'old');
    ins.run(now - 23 * HOUR, 'app_focus', 'recent');
    ins.run(now, 'app_focus', 'now');

    const removed = purgeExpired(db, 24, now);

    expect(removed).toBe(1);
    expect(countEvents(db)).toBe(2);
  });
});
