import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepos, gitToday, resume, ago } from '../src/git/git.js';

const EMAIL = 'test@agentik.dev';
let base: string, work: string;
const prevGlobal = process.env.GIT_CONFIG_GLOBAL;

function git(cwd: string, args: string[], date?: string): void {
  execFileSync('git', ['-c', `user.email=${EMAIL}`, '-c', 'user.name=T', ...args], {
    cwd,
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    stdio: 'ignore',
  });
}

function repo(name: string, subject: string, date?: string): string {
  const p = join(work, name);
  mkdirSync(p, { recursive: true });
  git(p, ['init', '-q', '-b', 'main']);
  writeFileSync(join(p, 'a.txt'), 'a');
  git(p, ['add', '.']);
  git(p, ['commit', '-q', '-m', subject], date);
  return p;
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'agentik-git-'));
  work = join(base, 'work');
  writeFileSync(join(base, 'gitconfig'), `[user]\n\temail = ${EMAIL}\n`);
  process.env.GIT_CONFIG_GLOBAL = join(base, 'gitconfig');

  const a = repo('proyecto-nuevo', 'feat: algo de hoy');
  writeFileSync(join(a, 'a.txt'), 'modificado'); // tracked: status empieza con " M"
  writeFileSync(join(a, 'pendiente.ts'), 'x');
  repo('proyecto-viejo', 'chore: viejo', new Date(Date.now() - 10 * 86400_000).toISOString());
  mkdirSync(join(work, 'proyecto-nuevo/node_modules/dep/.git'), { recursive: true });
});

afterAll(() => {
  if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
  rmSync(base, { recursive: true, force: true });
});

describe('git', () => {
  it('findRepos ignora node_modules', async () => {
    const repos = (await findRepos([work])).map((r) => r.split('/').pop()).sort();
    expect(repos).toEqual(['proyecto-nuevo', 'proyecto-viejo']);
  }, 30_000);

  it('gitToday lista solo proyectos con actividad de hoy', async () => {
    const out = await gitToday([work]);
    expect(out).toContain('proyecto-nuevo: 1 commit (feat: algo de hoy), 2 archivos sin commit');
    expect(out).not.toContain('proyecto-viejo');
  }, 30_000);

  it('gitToday vacío si no hay actividad', async () => {
    expect(await gitToday([work], new Date(Date.now() + 5 * 86400_000))).toBe('');
  }, 30_000);

  it('resume muestra el último proyecto, lo pendiente y los anteriores', async () => {
    const out = await resume([work]);
    expect(out).toContain('Tu último proyecto: proyecto-nuevo');
    expect(out).toContain('rama main');
    expect(out).toContain('Último commit: feat: algo de hoy');
    expect(out).toContain('Sin commit: 2 archivos (a.txt, pendiente.ts)');
    expect(out).toContain('Antes: proyecto-viejo (hace 10 días)');
  }, 30_000);

  it('ago', () => {
    const now = Date.now();
    expect(ago(now - 1 * 60_000, now)).toBe('hace 1 minuto');
    expect(ago(now - 3 * 3600_000, now)).toBe('hace 3 horas');
    expect(ago(now - 25 * 3600_000, now)).toBe('ayer');
    expect(ago(now - 5 * 86400_000, now)).toBe('hace 5 días');
  });
});
