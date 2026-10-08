import { describe, it, expect } from 'vitest';
import { memoryDb } from './helpers.js';
import { recentEventsSummary } from '../src/ai/eventSummary.js';

describe('recentEventsSummary', () => {
  it('retorna vacío sin eventos', () => {
    const db = memoryDb();
    expect(recentEventsSummary(db)).toBe('');
  });

  it('resume tiempo por app', () => {
    const db = memoryDb();
    const now = Date.now();
    db.prepare('INSERT INTO events (ts, kind, app, title, duration_ms) VALUES (?, ?, ?, ?, ?)').run(now - 1000, 'app_focus', 'VS Code', 'index.ts', 300000);
    db.prepare('INSERT INTO events (ts, kind, app, title, duration_ms) VALUES (?, ?, ?, ?, ?)').run(now - 500, 'app_focus', 'VS Code', 'types.ts', 120000);
    db.prepare('INSERT INTO events (ts, kind, app, path) VALUES (?, ?, ?, ?)').run(now - 200, 'file_change', 'VS Code', '/src/index.ts');

    const summary = recentEventsSummary(db);
    expect(summary).toContain('VS Code');
    expect(summary).toContain('7 min');
    expect(summary).toContain('/src/index.ts');
  });
});
