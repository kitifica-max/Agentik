import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db';
import { Observer, type WindowReader } from '../src/observer/observer';
import { isInside } from '../src/observer/fileWatcher';
import { cfg, countEvents, memoryDb } from './helpers';

let db: Db;
let current: { app: string; title: string } | null;
const reader: WindowReader = async () => ({ window: current, permissionsOk: true });

beforeEach(() => {
  db = memoryDb();
  current = null;
});
afterEach(() => db.close());

describe('Observer', () => {
  it('no observa hasta activarlo por primera vez', async () => {
    const obs = new Observer(db, cfg, reader);
    current = { app: 'Code', title: 'x' };
    await obs.tick(0);
    await obs.tick(5000);
    expect(countEvents(db)).toBe(0);
  });

  it('registra duración por segmento al cambiar de ventana', async () => {
    const obs = new Observer(db, cfg, reader);
    obs.setEnabled(true);
    current = { app: 'Code', title: 'a' };
    await obs.tick(0);
    await obs.tick(5000);
    current = { app: 'Safari', title: 'b' };
    await obs.tick(10000);
    const rows = db.prepare('SELECT app, duration_ms FROM events').all() as { app: string; duration_ms: number }[];
    expect(rows).toEqual([{ app: 'Code', duration_ms: 10000 }]);
  });

  it('pausa descarta el segmento abierto y no graba mientras dure', async () => {
    const obs = new Observer(db, cfg, reader);
    obs.setEnabled(true);
    current = { app: 'Code', title: 'a' };
    await obs.tick(0);
    obs.togglePause();
    await obs.tick(5000);
    current = { app: 'Safari', title: 'b' };
    await obs.tick(10000);
    obs.togglePause();
    await obs.tick(15000);
    expect(countEvents(db)).toBe(0);
  });

  it('una ventana excluida corta el segmento y no se guarda', async () => {
    const obs = new Observer(db, cfg, reader);
    obs.setEnabled(true);
    current = { app: 'Code', title: 'a' };
    await obs.tick(0);
    current = { app: 'Safari', title: 'Mi contraseña' };
    await obs.tick(5000);
    await obs.tick(9000);
    const apps = (db.prepare('SELECT app FROM events').all() as { app: string }[]).map((r) => r.app);
    expect(apps).toEqual(['Code']);
  });

  it('no guarda la propia app', async () => {
    const obs = new Observer(db, cfg, reader);
    obs.setEnabled(true);
    current = { app: 'Electron', title: 'Agentik' };
    await obs.tick(0);
    await obs.tick(5000);
    expect(countEvents(db)).toBe(0);
  });

  it('persiste activación y pausa entre instancias', () => {
    new Observer(db, cfg, reader).setEnabled(true);
    const again = new Observer(db, cfg, reader);
    expect(again.status().enabled).toBe(true);
  });
});

describe('isInside (rutas autorizadas)', () => {
  it('rechaza ../ y rutas fuera de la raíz', () => {
    expect(isInside('/proj', '/proj/src/a.ts')).toBe(true);
    expect(isInside('/proj', '/proj/../etc/passwd')).toBe(false);
    expect(isInside('/proj', '/proj')).toBe(false);
    expect(isInside('/proj', '/projx/a.ts')).toBe(false);
  });
});
