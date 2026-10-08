import { describe, it, expect } from 'vitest';
import { memoryDb } from './helpers.js';
import { dailySummary } from '../src/summary/daily.js';
import { parseConfig, DEFAULT_SHORTCUTS } from '../src/main/config.js';

const MIN = 60_000;

describe('dailySummary', () => {
  it('sin eventos avisa', () => {
    expect(dailySummary(memoryDb())).toContain('Sin actividad');
  });

  it('agrega tiempo por app, cambios, sesión más larga y archivos', () => {
    const db = memoryDb();
    const now = Date.now();
    const f = db.prepare('INSERT INTO events (ts, kind, app, title, duration_ms) VALUES (?, ?, ?, ?, ?)');
    f.run(now - 3 * 3600_000, 'app_focus', 'VS Code', 'a', 90 * MIN);
    f.run(now - 2 * 3600_000, 'app_focus', 'Chrome', 'b', 30 * MIN);
    f.run(now - 1 * 3600_000, 'app_focus', 'VS Code', 'c', 60 * MIN);
    const c = db.prepare('INSERT INTO events (ts, kind, path) VALUES (?, ?, ?)');
    for (let i = 0; i < 3; i++) c.run(now - i * 1000, 'file_change', '/x/engine.ts');
    c.run(now - 5000, 'file_change', '/x/otro.ts');
    db.prepare('INSERT INTO events (ts, kind, app, title, duration_ms) VALUES (?, ?, ?, ?, ?)')
      .run(now - 40 * 3600_000, 'app_focus', 'Viejo', 'z', 500 * MIN);

    const out = dailySummary(db, 24, now);
    expect(out).toContain('Tiempo registrado: 3 h');
    expect(out).toContain('VS Code 2 h 30 min');
    expect(out).toContain('Chrome 30 min');
    expect(out).toContain('Cambios de app: 2');
    expect(out).toContain('Sesión más larga: VS Code, 1 h 30 min');
    expect(out).toContain('Archivos modificados: 2 (más editado: engine.ts, 3 veces)');
    expect(out).not.toContain('Viejo');
  });
});

describe('config: atajos y reglas', () => {
  it('defaults', () => {
    const c = parseConfig({});
    expect(c.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(c.custom_rules).toEqual([]);
    expect(c.launch_at_login).toBe(true);
  });

  it('override parcial de atajos conserva el resto', () => {
    const c = parseConfig({ shortcuts: { summary: 'Control+Alt+S' } });
    expect(c.shortcuts.summary).toBe('Control+Alt+S');
    expect(c.shortcuts.pause).toBe(DEFAULT_SHORTCUTS.pause);
  });

  it('rechaza regla sin mensaje', () => {
    expect(() => parseConfig({ custom_rules: [{ app: 'Figma', minutes: 120 }] })).toThrow();
  });
});
