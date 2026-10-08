import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const G = createRequire(import.meta.url)('../src/renderer/onboarding.js') as {
  STEPS: { id: string; title: string; body: string[] }[];
  EXAMPLES: { text: string; note: string }[];
  checklist: (s: { hasModel: boolean; folders: number; observing: boolean; chatted: boolean }) => { id: string; done: boolean; go: string }[];
  progress: (i: { done: boolean }[]) => { done: number; total: number; text: string };
};

describe('guía de inicio', () => {
  it('lista marca solo lo que ya está hecho', () => {
    const items = G.checklist({ hasModel: true, folders: 0, observing: false, chatted: true });
    expect(items.filter((i) => i.done).map((i) => i.id)).toEqual(['modelo', 'mensaje']);
    expect(G.progress(items).text).toBe('2 de 4 listos');
  });
  it('todo vacío: 0 de 4', () => {
    expect(G.progress(G.checklist({ hasModel: false, folders: 0, observing: false, chatted: false })).done).toBe(0);
  });
  it('cada paso pendiente lleva a una pestaña o acción conocida', () => {
    const ok = ['models', 'files', 'observer', 'chat'];
    for (const i of G.checklist({ hasModel: false, folders: 0, observing: false, chatted: false })) expect(ok).toContain(i.go);
  });
  it('pasos con título y contenido, sin ids repetidos', () => {
    expect(new Set(G.STEPS.map((s) => s.id)).size).toBe(G.STEPS.length);
    for (const s of G.STEPS) expect(s.title && s.body.length).toBeTruthy();
  });
  it('ejemplos sin comandos peligrosos ni secretos', () => {
    for (const e of G.EXAMPLES) expect(e.text).not.toMatch(/\b(rm|sudo|limpia)\b|api[_ ]?key/i);
  });
  it('los atajos de la guía son los reales del config', () => {
    const cfg = readFileSync('src/main/config.ts', 'utf8');
    expect(cfg).toContain("'CommandOrControl+Shift+P'");
    expect(cfg).toContain("'Control+Alt+A'");
    expect(cfg).toContain("'Control+Alt+R'");
    expect(cfg).toContain("'Control+Alt+N'");
  });
});
