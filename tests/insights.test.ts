import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb, cfg } from './helpers.js';
import { recordEvent } from '../src/observer/recorder.js';
import { purgeExpired } from '../src/observer/retention.js';
import { habitInsights, habitDays, proposeInsights, projectInsights, detectStack, learn, MIN_HABIT_DAYS } from '../src/memory/insights.js';
import { listMemories, rejectMemory } from '../src/memory/memory.js';
import { notificationBody, shouldNotify } from '../src/main/notify.js';
import { parseConfig } from '../src/main/config.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const focus = (db: ReturnType<typeof memoryDb>, ts: number, app: string, ms: number, title = 'ventana') =>
  recordEvent(db, cfg, { ts, kind: 'app_focus', app, title, duration_ms: ms });
const stats = (db: ReturnType<typeof memoryDb>) => db.prepare('SELECT day, hour, app, ms FROM habit_stats ORDER BY day, hour, app').all() as { day: string; hour: number; app: string; ms: number }[];

describe('resumen de hábitos (habit_stats)', () => {
  it('acumula por día, hora y app, y reparte un uso largo entre las horas que cruza', () => {
    const db = memoryDb();
    focus(db, new Date(2026, 9, 5, 10, 30).getTime(), 'Claude', 90 * MIN); // 10:30 → 12:00
    focus(db, new Date(2026, 9, 5, 11, 0).getTime(), 'Claude', 10 * MIN);
    expect(stats(db)).toEqual([
      { day: '2026-10-05', hour: 10, app: 'Claude', ms: 30 * MIN },
      { day: '2026-10-05', hour: 11, app: 'Claude', ms: 70 * MIN },
    ]);
  });

  it('privacidad: lo excluido jamás llega al resumen y solo se guarda día/hora/app/ms (sin títulos)', () => {
    const db = memoryDb();
    focus(db, Date.now(), 'Bitwarden', 5 * MIN); // app excluida
    focus(db, Date.now(), 'Safari', 5 * MIN, 'Mi banco - inicio'); // título excluido
    recordEvent(db, cfg, { ts: Date.now(), kind: 'app_focus', app: 'Notes', title: 'x' }); // sin duración
    expect(stats(db)).toEqual([]);
    const cols = (db.prepare("PRAGMA table_info('habit_stats')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['day', 'hour', 'app', 'ms']);
  });

  it('la retención borra el resumen viejo (60 días por defecto) y respeta lo reciente', () => {
    const db = memoryDb();
    const now = new Date(2026, 9, 20, 12).getTime();
    focus(db, new Date(2026, 6, 1, 9).getTime(), 'Claude', 5 * MIN); // ~111 días atrás
    focus(db, new Date(2026, 9, 10, 9).getTime(), 'Claude', 5 * MIN);
    purgeExpired(db, 24, now, 60);
    expect(stats(db).map((s) => s.day)).toEqual(['2026-10-10']);
  });
});

describe('hábitos → recuerdos propuestos', () => {
  function seed(days: number) {
    const db = memoryDb();
    for (let d = 0; d < days; d++) {
      for (const h of [9, 10, 11, 12]) focus(db, new Date(2026, 9, 1 + d, h, 0).getTime(), 'Claude', HOUR);
      focus(db, new Date(2026, 9, 1 + d, 21, 0).getTime(), 'Terminal', HOUR);
      focus(db, new Date(2026, 9, 1 + d, 15, 0).getTime(), 'Finder', 2 * MIN); // ruido: <5 %
    }
    return db;
  }

  it('con menos de 3 días no inventa hábitos', () => {
    const db = seed(2);
    expect(habitDays(db)).toBe(2);
    expect(habitInsights(db)).toEqual([]);
    expect(MIN_HABIT_DAYS).toBe(3);
  });

  it('detecta apps principales (sin el ruido) y horas de más actividad', () => {
    const out = habitInsights(seed(4));
    const apps = out.find((i) => i.fuente === 'insight:habit-apps')!;
    expect(apps.contenido).toBe('Hábito: las apps que más usa son Claude y Terminal.');
    const hours = out.find((i) => i.fuente === 'insight:habit-hours')!;
    expect(hours.contenido).toContain('entre las 9:00 y las 13:00');
    expect(hours.contenido).toContain('entre las 21:00 y las 22:00');
    expect(out.every((i) => i.tipo === 'contexto')).toBe(true);
  });

  it('se proponen (nunca se guardan solas) y no se repiten; un hábito puede actualizarse pasados 30 días', () => {
    const db = seed(4);
    const t0 = Date.now();
    const first = proposeInsights(db, habitInsights(db), t0);
    expect(first).toHaveLength(2);
    expect(listMemories(db).every((m) => m.estado === 'propuesto')).toBe(true);
    expect(proposeInsights(db, habitInsights(db), t0 + 5 * 86_400_000)).toHaveLength(0);
    expect(proposeInsights(db, habitInsights(db), t0 + 31 * 86_400_000)).toHaveLength(2);
  });

  it('un proyecto rechazado no vuelve a proponerse nunca; lo sensible se descarta', () => {
    const db = memoryDb();
    const p = { fuente: 'insight:project:/x/app', tipo: 'proyecto' as const, contenido: 'Trabaja en el proyecto "app".' };
    const [m] = proposeInsights(db, [p]);
    rejectMemory(db, m!.id);
    expect(proposeInsights(db, [p], Date.now() + 400 * 86_400_000)).toHaveLength(0);
    expect(proposeInsights(db, [{ fuente: 'insight:project:/x/b', tipo: 'proyecto', contenido: 'Trabaja en el proyecto "banco-app".' }])).toHaveLength(0);
  });
});

describe('proyectos → recuerdos propuestos', () => {
  let base: string, work: string;
  const git = (cwd: string, args: string[], date?: string) =>
    execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=T', ...args], { cwd, stdio: 'ignore', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
  const repo = (name: string, files: Record<string, string>, date?: string) => {
    const p = join(work, name);
    mkdirSync(p, { recursive: true });
    for (const [f, c] of Object.entries(files)) writeFileSync(join(p, f), c);
    git(p, ['init', '-q', '-b', 'main']);
    git(p, ['add', '.']);
    git(p, ['commit', '-q', '-m', 'init'], date);
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'agentik-ins-'));
    work = join(base, 'work');
    repo('mi-app', {
      'package.json': JSON.stringify({ name: 'mi-app', description: 'Tienda   de\nsemillas', dependencies: { next: '1', react: '1' }, devDependencies: { typescript: '5' } }),
      'tsconfig.json': '{}',
    });
    repo('sin-desc', { 'index.html': '<html>' });
    repo('viejo', { 'README.md': 'x' }, new Date(Date.now() - 90 * 86_400_000).toISOString());
    mkdirSync(join(work, 'mi-app/node_modules/dep/.git'), { recursive: true });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('propone solo proyectos con actividad en los últimos 30 días, con su descripción y stack', async () => {
    const out = await projectInsights([work], Date.now(), base);
    expect(out).toHaveLength(2); // mi-app y sin-desc; "viejo" (90 días) y el repo dentro de node_modules no
    const byName = (n: string) => out.find((i) => i.fuente.endsWith(`/${n}`))!;
    expect(byName('mi-app')).toMatchObject({ tipo: 'proyecto', fuente: `insight:project:${join(work, 'mi-app')}` });
    expect(byName('mi-app').contenido).toBe('Trabaja en el proyecto "mi-app" en ~/work/mi-app: Tienda de semillas (Next.js, React, TypeScript).');
    expect(byName('sin-desc').contenido).toBe('Trabaja en el proyecto "sin-desc" en ~/work/sin-desc (HTML/CSS/JS).'); // sin ":" si no hay descripción
  }, 30_000);

  it('learn() deja las propuestas en la base, pendientes de aprobación', async () => {
    const db = memoryDb();
    const r = await learn(db, [work]);
    expect(r.created).toHaveLength(2);
    expect(r.habitDays).toBe(0);
    expect(listMemories(db).every((m) => m.estado === 'propuesto' && m.tipo === 'proyecto')).toBe(true);
    expect((await learn(db, [work])).created).toHaveLength(0); // no repite
  }, 30_000);
});

describe('detectStack', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'agentik-stack-'));
  it('Electron + TypeScript, Python y HTML suelto', () => {
    const a = tmp();
    writeFileSync(join(a, 'package.json'), JSON.stringify({ devDependencies: { electron: '1', typescript: '5' } }));
    expect(detectStack(a).stack).toEqual(['Electron', 'TypeScript']);
    const b = tmp();
    writeFileSync(join(b, 'requirements.txt'), 'flask');
    expect(detectStack(b).stack).toEqual(['Python']);
    const c = tmp();
    writeFileSync(join(c, 'index.html'), '<html>');
    expect(detectStack(c).stack).toEqual(['HTML/CSS/JS']);
    for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
  });
});

describe('avisos', () => {
  it('cuerpo de una línea y recortado', () => {
    expect(notificationBody('  Listo.\n\nMovi   12 archivos  ')).toBe('Listo. Movi 12 archivos');
    const long = notificationBody('a'.repeat(300));
    expect(long).toHaveLength(140);
    expect(long.endsWith('…')).toBe(true);
  });

  it('avisa solo si están activados y no estás mirando la burbuja', () => {
    expect(shouldNotify({ enabled: true, bubbleVisible: false, bubbleFocused: false })).toBe(true);
    expect(shouldNotify({ enabled: true, bubbleVisible: true, bubbleFocused: false })).toBe(true);
    expect(shouldNotify({ enabled: true, bubbleVisible: true, bubbleFocused: true })).toBe(false);
    expect(shouldNotify({ enabled: false, bubbleVisible: false, bubbleFocused: false })).toBe(false);
  });

  it('config: avisos activados y hábitos 60 días por defecto', () => {
    const c = parseConfig({});
    expect(c.notifications).toBe(true);
    expect(c.habit_retention_days).toBe(60);
    expect(() => parseConfig({ habit_retention_days: 2 })).toThrow();
  });
});
