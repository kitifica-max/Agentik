import { describe, it, expect } from 'vitest';
import { memoryDb, cfg } from './helpers.js';
import { SuggestionEngine } from '../src/suggestions/engine.js';
import type { Config } from '../src/shared/types.js';

function cfgWith(level: Config['suggestion_level']): Config {
  return { ...cfg, suggestion_level: level };
}

function seedFocus(db: ReturnType<typeof memoryDb>, app: string, count: number, durationMs: number, now: number) {
  const stmt = db.prepare('INSERT INTO events (ts, kind, app, title, duration_ms) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < count; i++) {
    stmt.run(now - (count - i) * 5000, 'app_focus', app, 'window', durationMs);
  }
}

function seedFileChanges(db: ReturnType<typeof memoryDb>, path: string, count: number, now: number) {
  const stmt = db.prepare('INSERT INTO events (ts, kind, path) VALUES (?, ?, ?)');
  for (let i = 0; i < count; i++) {
    stmt.run(now - (count - i) * 1000, 'file_change', path);
  }
}

describe('SuggestionEngine', () => {
  it('silencio nunca sugiere', () => {
    const db = memoryDb();
    const engine = new SuggestionEngine(db, cfgWith('silencio'));
    seedFocus(db, 'VS Code', 10, 5 * 60_000, Date.now());
    expect(engine.evaluate()).toBeNull();
  });

  it('sin eventos suficientes no sugiere', () => {
    const db = memoryDb();
    const engine = new SuggestionEngine(db, cfgWith('activo'));
    expect(engine.evaluate()).toBeNull();
  });

  it('detecta long_focus (>30 min misma app)', () => {
    const db = memoryDb();
    const now = Date.now();
    const engine = new SuggestionEngine(db, cfgWith('discreto'));
    seedFocus(db, 'VS Code', 8, 5 * 60_000, now);
    const s = engine.evaluate(now);
    expect(s).not.toBeNull();
    expect(s!.rule).toBe('long_focus');
    expect(s!.text).toContain('VS Code');
  });

  it('detecta rapid_switching (>5 apps en 5 min)', () => {
    const db = memoryDb();
    const now = Date.now();
    const engine = new SuggestionEngine(db, cfgWith('discreto'));
    const apps = ['Chrome', 'Slack', 'Finder', 'Terminal', 'Notes', 'Mail'];
    const stmt = db.prepare('INSERT INTO events (ts, kind, app, title, duration_ms) VALUES (?, ?, ?, ?, ?)');
    apps.forEach((app, i) => stmt.run(now - (apps.length - i) * 10_000, 'app_focus', app, 'x', 8000));
    const s = engine.evaluate(now);
    expect(s).not.toBeNull();
    expect(s!.rule).toBe('rapid_switching');
  });

  it('detecta repeated_edits solo en activo', () => {
    const db = memoryDb();
    const now = Date.now();
    // discreto no detecta repeated_edits
    const engineD = new SuggestionEngine(db, cfgWith('discreto'));
    seedFocus(db, 'VS Code', 3, 1000, now);
    seedFileChanges(db, '/src/index.ts', 4, now);
    expect(engineD.evaluate(now)?.rule).not.toBe('repeated_edits');

    // activo sí
    const db2 = memoryDb();
    const engineA = new SuggestionEngine(db2, cfgWith('activo'));
    seedFocus(db2, 'VS Code', 3, 1000, now);
    seedFileChanges(db2, '/src/index.ts', 4, now);
    const s = engineA.evaluate(now);
    expect(s).not.toBeNull();
    expect(s!.rule).toBe('repeated_edits');
    expect(s!.text).toContain('index.ts');
  });

  it('respeta cooldown', () => {
    const db = memoryDb();
    const now = Date.now();
    const engine = new SuggestionEngine(db, cfgWith('activo'));
    seedFocus(db, 'VS Code', 8, 5 * 60_000, now);

    const s1 = engine.evaluate(now);
    expect(s1).not.toBeNull();

    // Inmediatamente después, cooldown activo
    expect(engine.evaluate(now + 1000)).toBeNull();

    // Después del cooldown (5 min para activo)
    const s2 = engine.evaluate(now + 5 * 60_000 + 1);
    expect(s2).not.toBeNull();
  });

  it('dismiss suprime la regla una vez', () => {
    const db = memoryDb();
    const now = Date.now();
    const engine = new SuggestionEngine(db, cfgWith('activo'));
    seedFocus(db, 'VS Code', 8, 5 * 60_000, now);

    const s = engine.evaluate(now);
    expect(s).not.toBeNull();
    engine.dismiss(s!.rule);

    // Misma regla suprimida incluso después de cooldown
    const s2 = engine.evaluate(now + 5 * 60_000 + 1);
    expect(s2).toBeNull();
  });

  it('detecta inactivity solo en activo', () => {
    const db = memoryDb();
    const now = Date.now();
    const engine = new SuggestionEngine(db, cfgWith('activo'));
    // 5 eventos hace 15 min, nada desde entonces
    const stmt = db.prepare('INSERT INTO events (ts, kind, app, title, duration_ms) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 6; i++) {
      stmt.run(now - 15 * 60_000 - i * 1000, 'app_focus', 'VS Code', 'x', 1000);
    }
    const s = engine.evaluate(now);
    expect(s).not.toBeNull();
    expect(s!.rule).toBe('inactivity');
  });

  it('regla propia: misma app X minutos dispara su mensaje', () => {
    const db = memoryDb();
    const now = Date.now();
    const config = { ...cfgWith('discreto'), custom_rules: [{ app: 'figma', minutes: 120, message: 'Exporta assets.' }] };
    seedFocus(db, 'Figma', 4, 40 * 60_000, now);
    const s = new SuggestionEngine(db, config).evaluate(now);
    expect(s?.text).toBe('Exporta assets.');
    expect(s?.rule).toBe('custom:0');
  });

  it('regla propia: no dispara si no llega al tiempo o es otra app', () => {
    const db = memoryDb();
    const now = Date.now();
    const config = { ...cfgWith('activo'), custom_rules: [{ app: 'Figma', minutes: 120, message: 'x' }] };
    seedFocus(db, 'Figma', 4, 10 * 60_000, now);
    expect(new SuggestionEngine(db, config).evaluate(now)?.rule).not.toBe('custom:0');
  });

  it('regla propia con title_contains', () => {
    const db = memoryDb();
    const now = Date.now();
    const config = { ...cfgWith('discreto'), custom_rules: [{ app: 'Chrome', title_contains: 'youtube', minutes: 30, message: 'Mucho YouTube.' }] };
    const stmt = db.prepare('INSERT INTO events (ts, kind, app, title, duration_ms) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 4; i++) stmt.run(now - (4 - i) * 5000, 'app_focus', 'Chrome', 'YouTube - video', 10 * 60_000);
    expect(new SuggestionEngine(db, config).evaluate(now)?.text).toBe('Mucho YouTube.');
  });
});
