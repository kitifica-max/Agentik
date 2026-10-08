import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { runCommand } from '../shell/shell.js';

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const sh = async (cmd: string, secs = 30): Promise<string> =>
  (await runCommand(cmd, { cwd: '/', timeoutMs: secs * 1000 })).output.trim();

export interface RepoInfo {
  path: string;
  name: string;
  branch: string;
  commitsToday: string[];
  dirty: string[];
  lastSubject: string;
  lastTouched: number; // ms: lo más reciente entre el último commit y los archivos sin commit
}

export async function findRepos(roots: string[]): Promise<string[]> {
  const rs = roots.filter((r) => existsSync(r));
  if (rs.length === 0) return [];
  const out = await sh(
    `find ${rs.map(q).join(' ')} -maxdepth 4 \\( -name node_modules -o -name Library \\) -prune -o -name .git -type d -print 2>/dev/null | head -80`,
    60,
  );
  return out.split('\n').filter(Boolean).map((p) => dirname(p));
}

const startOfDay = (d: Date): Date => { const s = new Date(d); s.setHours(0, 0, 0, 0); return s; };

export async function repoInfo(repo: string, since: Date, email: string): Promise<RepoInfo> {
  const g = (args: string): Promise<string> => sh(`git -C ${q(repo)} ${args} 2>/dev/null`, 20);
  const author = email ? ` --author=${q(email)}` : '';
  const [branch, today, status, last] = await Promise.all([
    g('rev-parse --abbrev-ref HEAD'),
    g(`log --since=${q(since.toISOString())}${author} --pretty=%s`),
    // sin trim: la primera línea puede empezar con espacio (" M archivo")
    runCommand(`git -C ${q(repo)} status --porcelain 2>/dev/null`, { cwd: '/', timeoutMs: 20_000 }).then((r) => r.output),
    g('log -1 --pretty=%ct%x09%s'),
  ]);

  const dirty = status.split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
  let touched = 0;
  for (const f of dirty.slice(0, 50)) {
    try { touched = Math.max(touched, statSync(`${repo}/${f}`).mtimeMs); } catch { /* borrado */ }
  }
  const [ct, ...subj] = last.split('\t');
  return {
    path: repo,
    name: basename(repo),
    branch: branch || '?',
    commitsToday: today.split('\n').filter(Boolean),
    dirty,
    lastSubject: subj.join('\t'),
    lastTouched: Math.max(touched, (parseInt(ct ?? '', 10) || 0) * 1000),
  };
}

async function scan(roots: string[], now: Date): Promise<{ infos: RepoInfo[]; since: Date }> {
  const email = await sh('git config --global user.email');
  const since = startOfDay(now);
  const repos = await findRepos(roots);
  const infos: RepoInfo[] = [];
  for (let i = 0; i < repos.length; i += 6) {
    infos.push(...(await Promise.all(repos.slice(i, i + 6).map((r) => repoInfo(r, since, email)))));
  }
  return { infos, since };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function gitToday(roots: string[], now = new Date()): Promise<string> {
  const { infos, since } = await scan(roots, now);
  const active = infos
    .filter((i) => i.commitsToday.length > 0 || (i.dirty.length > 0 && i.lastTouched >= since.getTime()))
    .sort((a, b) => b.lastTouched - a.lastTouched)
    .slice(0, 6);
  if (active.length === 0) return '';
  const lines = ['En tus proyectos hoy:'];
  for (const i of active) {
    const parts: string[] = [];
    if (i.commitsToday.length) parts.push(`${plural(i.commitsToday.length, 'commit', 'commits')} (${i.commitsToday.slice(0, 2).join('; ')})`);
    if (i.dirty.length) parts.push(`${plural(i.dirty.length, 'archivo', 'archivos')} sin commit`);
    lines.push(`• ${i.name}: ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

export function ago(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 60) return `hace ${plural(min, 'minuto', 'minutos')}`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${plural(h, 'hora', 'horas')}`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

// "Retoma donde me quedé": proyecto con actividad más reciente, qué quedó pendiente y los anteriores.
export async function resume(roots: string[], now = new Date()): Promise<string> {
  const { infos } = await scan(roots, now);
  const recent = infos.filter((i) => i.lastTouched > 0).sort((a, b) => b.lastTouched - a.lastTouched);
  const top = recent[0];
  if (!top) return 'No encontré proyectos con git en tus carpetas.';

  const out = [`Tu último proyecto: ${top.name} (${ago(top.lastTouched, now.getTime())}), rama ${top.branch}.`, `Ruta: ${top.path}`];
  if (top.lastSubject) out.push(`Último commit: ${top.lastSubject}`);
  if (top.dirty.length) {
    const names = top.dirty.slice(0, 5).map((f) => basename(f)).join(', ');
    out.push(`Sin commit: ${plural(top.dirty.length, 'archivo', 'archivos')} (${names}${top.dirty.length > 5 ? ', …' : ''})`);
  } else {
    out.push('Todo está commiteado.');
  }
  const before = recent.slice(1, 4).map((i) => `${i.name} (${ago(i.lastTouched, now.getTime())})`);
  if (before.length) out.push(`Antes: ${before.join(', ')}`);
  return out.join('\n');
}
