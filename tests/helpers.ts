import { parseConfig } from '../src/main/config';
import { openDb, type Db } from '../src/db/db';

export const cfg = parseConfig({});

export function memoryDb(): Db {
  return openDb(':memory:');
}

export function countEvents(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
}
