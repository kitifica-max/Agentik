import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { ScriptDef } from '../types.js';
import { fmtSize, plural } from './util.js';

const CARPETA = { name: 'carpeta', label: 'Carpeta de proyectos', type: 'folder' as const, required: true };

/** Busca carpetas con ese nombre sin entrar en ellas (ni en ocultas). */
function findDirs(root: string, target: string, maxDepth: number): string[] {
  const out: string[] = [];
  const go = (dir: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') && n !== target) continue;
      const full = join(dir, n);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (n === target) { out.push(full); continue; }
      if (depth < maxDepth) go(full, depth + 1);
    }
  };
  go(root, 1);
  return out;
}

// ── node_modules viejos ──────────────────────────────────────────────────────────────────────
export const nodeModulesViejos: ScriptDef = {
  id: 'node-modules-viejos', title: 'node_modules viejos', group: 'dev', risk: 'mueve', requires: ['du'],
  description: 'Manda a la Papelera los node_modules de proyectos que no tocas hace tiempo. Se reinstalan con npm install y se puede deshacer.',
  params: [CARPETA, { name: 'dias', label: 'Proyecto sin tocar hace (días)', type: 'number', default: 60, min: 1, max: 3650 }],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const limit = ctx.now() - Number(p.dias) * 86400_000;
    const hits: { path: string; bytes: number }[] = [];
    for (const nm of findDirs(root, 'node_modules', 5)) {
      const proj = dirname(nm);
      let touched = 0;
      for (const f of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) { try { touched = Math.max(touched, statSync(join(proj, f)).mtimeMs); } catch { /* no existe */ } }
      if (!touched) { try { touched = statSync(proj).mtimeMs; } catch { continue; } }
      if (touched >= limit) continue;
      const r = await ctx.exec(ctx.bin('du')!, ['-sk', nm], { timeoutMs: 120_000 });
      hits.push({ path: nm, bytes: (Number(r.stdout.split(/\s/)[0]) || 0) * 1024 });
    }
    hits.sort((a, b) => b.bytes - a.bytes);
    const total = hits.reduce((n, h) => n + h.bytes, 0);
    return {
      summary: hits.length ? `${plural(hits.length, 'node_modules', 'node_modules')} (${fmtSize(total)}) a la Papelera.` : 'No hay node_modules de proyectos abandonados.',
      lines: hits.map((h) => `${fmtSize(h.bytes)}  ${relative(root, h.path)}`), count: hits.length, data: { paths: hits.map((h) => h.path), total },
    };
  },
  async run(ctx, _p, plan) {
    const { paths, total } = plan.data as { paths: string[]; total: number };
    let ok = 0;
    for (const pth of paths) { try { ctx.fs.toTrash(pth); ok++; } catch { /* otro disco o sin permiso */ } }
    return { summary: `Listo: ${plural(ok, 'node_modules enviado', 'node_modules enviados')} a la Papelera (hasta ${fmtSize(total)}).` };
  },
};

// ── .env.example ─────────────────────────────────────────────────────────────────────────────
export const envExample: ScriptDef = {
  id: 'env-example', title: '.env.example sin valores', group: 'dev', risk: 'escribe',
  description: 'Crea un .env.example con solo los NOMBRES de las variables de cada .env. Los valores nunca se copian ni se muestran.',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const jobs: { env: string; example: string; keys: string[] }[] = [];
    for (const f of ctx.fs.walk(root, { hidden: true, maxDepth: 3 })) {
      if (f.isDir || f.name !== '.env') continue;
      const example = join(dirname(f.path), '.env.example');
      if (existsSync(example)) continue;
      const keys = readFileSync(f.path, 'utf8').split('\n').map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter((k): k is string => !!k);
      if (keys.length) jobs.push({ env: f.path, example, keys });
    }
    return {
      summary: jobs.length ? `${plural(jobs.length, '.env.example', '.env.example')} a crear (${jobs.reduce((n, j) => n + j.keys.length, 0)} variables, sin valores).` : 'No hay .env sin su .env.example.',
      lines: jobs.map((j) => `${relative(root, j.example) || '.env.example'}  — ${j.keys.length} variables`), count: jobs.length, data: { jobs },
    };
  },
  async run(ctx, _p, plan) {
    const { jobs } = plan.data as { jobs: { example: string; keys: string[] }[] };
    for (const j of jobs) ctx.fs.writeNew(j.example, j.keys.map((k) => `${k}=`).join('\n') + '\n');
    return { summary: `Listo: ${plural(jobs.length, '.env.example creado', '.env.example creados')}.` };
  },
};

// ── Estado de repos ──────────────────────────────────────────────────────────────────────────
export const reposEstado: ScriptDef = {
  id: 'repos-estado', title: 'Estado de mis repos', group: 'dev', risk: 'lee', requires: ['git'],
  description: 'Recorre tus proyectos de git y muestra cuáles tienen cambios sin commit o commits sin subir.',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const gits = findDirs(root, '.git', 3).map(dirname);
    const lines: string[] = [];
    let pending = 0;
    for (const repo of [...new Set(gits)].sort()) {
      const r = await ctx.exec(ctx.bin('git')!, ['-C', repo, 'status', '--porcelain=v1', '-b'], { timeoutMs: 30_000 });
      if (r.code !== 0) continue;
      const rows = r.stdout.split('\n').filter(Boolean);
      const head = rows[0] ?? '';
      const changes = rows.length - 1;
      const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      const branch = /^## ([^.\s]+)/.exec(head)?.[1] ?? '?';
      if (changes > 0 || ahead > 0) pending++;
      lines.push(`${basename(repo)}  ${branch}${changes ? ` · ${plural(changes, 'cambio', 'cambios')}` : ''}${ahead ? ` · ${ahead} sin subir` : ''}${!changes && !ahead ? ' · limpio' : ''}`);
    }
    return { summary: lines.length ? `${plural(lines.length, 'repo', 'repos')}, ${pending} con algo pendiente.` : 'No encontré repos de git.', lines, count: lines.length, data: null };
  },
  async run(_ctx, _p, plan) { return { summary: plan.summary, lines: plan.lines }; },
};

export const DEV: ScriptDef[] = [nodeModulesViejos, envExample, reposEstado];
