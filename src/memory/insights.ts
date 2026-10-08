import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/db.js';
import type { Memory, MemoryTipo } from '../shared/types.js';
import { findRepos, repoInfo } from '../git/git.js';
import { proposeMemory } from './memory.js';

// Recuerdos que Agentik APRENDE solo, pero únicamente los PROPONE: se guardan si tú los apruebas.
// `fuente` es la clave para no volver a proponer lo mismo (ni lo que rechazaste).
export interface Insight { fuente: string; tipo: MemoryTipo; contenido: string }

const DAY_MS = 86_400_000;
export const MIN_HABIT_DAYS = 3; // con menos días de datos un "hábito" sería una anécdota

const joinEs = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

// ═══ Hábitos (a partir de habit_stats: app + hora + duración) ═══════════════════════════
export function habitDays(db: Db): number {
  return (db.prepare('SELECT COUNT(DISTINCT day) AS n FROM habit_stats').get() as { n: number }).n;
}

export function habitInsights(db: Db): Insight[] {
  if (habitDays(db) < MIN_HABIT_DAYS) return [];
  const rows = db.prepare('SELECT hour, app, SUM(ms) AS ms FROM habit_stats GROUP BY hour, app').all() as { hour: number; app: string; ms: number }[];
  const out: Insight[] = [];

  // Apps principales: las 3 con más tiempo, si pesan algo
  const byApp = new Map<string, number>();
  const byHour = new Array<number>(24).fill(0);
  for (const r of rows) {
    byApp.set(r.app, (byApp.get(r.app) ?? 0) + r.ms);
    byHour[r.hour]! += r.ms;
  }
  const total = [...byApp.values()].reduce((a, b) => a + b, 0);
  const top = [...byApp.entries()].sort((a, b) => b[1] - a[1]).filter(([, ms]) => ms >= total * 0.05).slice(0, 3).map(([a]) => a);
  if (top.length) out.push({ fuente: 'insight:habit-apps', tipo: 'contexto', contenido: `Hábito: las apps que más usa son ${joinEs(top)}.` });

  // Horas de más actividad: bloques seguidos de horas con al menos la mitad del máximo
  const max = Math.max(...byHour);
  if (max > 0) {
    const windows: { start: number; end: number; ms: number }[] = [];
    let cur: { start: number; end: number; ms: number } | null = null;
    for (let h = 0; h < 24; h++) {
      if (byHour[h]! >= max * 0.5) {
        if (cur) { cur.end = h + 1; cur.ms += byHour[h]!; } else cur = { start: h, end: h + 1, ms: byHour[h]! };
      } else if (cur) {
        windows.push(cur);
        cur = null;
      }
    }
    if (cur) windows.push(cur);
    const best = windows.sort((a, b) => b.ms - a.ms).slice(0, 2).sort((a, b) => a.start - b.start);
    if (best.length) {
      const txt = best.map((w) => `entre las ${w.start}:00 y las ${w.end % 24}:00`).join(' y ');
      out.push({ fuente: 'insight:habit-hours', tipo: 'contexto', contenido: `Hábito: suele estar más activo ${txt}.` });
    }
  }
  return out;
}

// ═══ Proyectos (repos de git con actividad reciente) ════════════════════════════════════
function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

const DEP_LABELS: [string, string][] = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['astro', 'Astro'],
  ['electron', 'Electron'], ['express', 'Express'], ['vite', 'Vite'], ['tailwindcss', 'Tailwind'],
];

export function detectStack(dir: string): { stack: string[]; description: string } {
  const stack: string[] = [];
  let description = '';
  const pkg = readJson(join(dir, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [k, label] of DEP_LABELS) if (k in deps) stack.push(label);
    if (deps.typescript || existsSync(join(dir, 'tsconfig.json'))) stack.push('TypeScript');
    if (stack.length === 0) stack.push('Node');
    if (typeof pkg.description === 'string') description = pkg.description.replace(/\s+/g, ' ').trim().slice(0, 100);
  }
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* sin acceso */ }
  if (names.some((n) => n === 'pyproject.toml' || n === 'requirements.txt')) stack.push('Python');
  if (names.some((n) => n === 'Package.swift' || n.endsWith('.xcodeproj'))) stack.push('Swift');
  if (names.includes('Cargo.toml')) stack.push('Rust');
  if (names.includes('go.mod')) stack.push('Go');
  if (!pkg && names.includes('index.html')) stack.push('HTML/CSS/JS');
  return { stack: [...new Set(stack)].slice(0, 5), description };
}

export async function projectInsights(roots: string[], now = Date.now(), home = homedir()): Promise<Insight[]> {
  const since = new Date(now - 30 * DAY_MS);
  const repos = await findRepos(roots);
  const infos: Awaited<ReturnType<typeof repoInfo>>[] = [];
  for (let i = 0; i < repos.length; i += 6) infos.push(...(await Promise.all(repos.slice(i, i + 6).map((r) => repoInfo(r, since, '')))));
  return infos
    .filter((r) => r.lastTouched >= since.getTime())
    .sort((a, b) => b.lastTouched - a.lastTouched)
    .slice(0, 6)
    .map((r) => {
      const { stack, description } = detectStack(r.path);
      const where = r.path.startsWith(home) ? `~${r.path.slice(home.length)}` : r.path;
      const desc = description ? `: ${description}` : '';
      const tech = stack.length ? ` (${stack.join(', ')})` : '';
      return { fuente: `insight:project:${r.path}`, tipo: 'proyecto' as const, contenido: `Trabaja en el proyecto "${r.name}" en ${where}${desc}${tech}.` };
    });
}

// ═══ Proponer sin repetir ═══════════════════════════════════════════════════════════════
// Un proyecto se propone una sola vez (aunque lo rechaces). Un hábito puede volver a proponerse
// pasados 30 días, porque cambia con el tiempo.
export function proposeInsights(db: Db, insights: Insight[], now = Date.now()): Memory[] {
  const created: Memory[] = [];
  for (const it of insights) {
    const prev = db.prepare('SELECT created_at FROM memories WHERE fuente = ? ORDER BY created_at DESC LIMIT 1').get(it.fuente) as { created_at: number } | undefined;
    if (prev && (it.fuente.startsWith('insight:project:') || now - prev.created_at < 30 * DAY_MS)) continue;
    const m = proposeMemory(db, it.contenido, it.tipo, it.fuente); // aplica el filtro de datos sensibles
    if (m) created.push(m);
  }
  return created;
}

export async function learn(db: Db, roots: string[], now = Date.now()): Promise<{ created: Memory[]; habitDays: number }> {
  const insights = [...(await projectInsights(roots, now)), ...habitInsights(db)];
  return { created: proposeInsights(db, insights, now), habitDays: habitDays(db) };
}
