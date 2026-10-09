import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Db } from '../db/db.js';
import type { Config } from '../shared/types.js';
import { logAudit, validatePath } from '../files/fileTools.js';
import { SafeFs, ScriptError } from './fsops.js';
import type { ExecResult, Group, ParamDef, ParamValues, Plan, Risk, ScriptCtx, ScriptDef } from './types.js';
import { LIBRARY } from './library/index.js';

export interface Deps {
  db: Db;
  config: Config;
  trashDir?: string;
  /** Herramienta externa → ruta (módulo descargado o del sistema), o null. */
  bin?: (name: string) => string | null;
}

export interface ScriptInfo {
  id: string; title: string; description: string; group: Group; risk: Risk; params: ParamDef[];
  requires: string[]; missing: string[];
}

const defaultTrash = (): string => join(homedir(), '.Trash');
const noBin = (): null => null;

export function findScript(id: string): ScriptDef | undefined {
  return LIBRARY.find((s) => s.id === id);
}

export function listScripts(deps: Pick<Deps, 'bin'> = {}): ScriptInfo[] {
  const bin = deps.bin ?? noBin;
  return LIBRARY.map((s) => ({
    id: s.id, title: s.title, description: s.description, group: s.group, risk: s.risk, params: s.params,
    requires: s.requires ?? [], missing: (s.requires ?? []).filter((r) => !bin(r)),
  }));
}

function exec(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 120_000, cwd: opts.cwd, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') });
    });
  });
}

/** Valida y completa los parámetros según la definición del script. Devuelve los valores limpios o un error legible. */
export function coerceParams(def: ScriptDef, raw: unknown, fs: SafeFs): { values: ParamValues } | { error: string } {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const values: ParamValues = {};
  for (const p of def.params) {
    let v = src[p.name];
    if (v === undefined || v === null || v === '') v = p.default;
    if (v === undefined || v === '') {
      if (p.required) return { error: `Falta «${p.label}»` };
      continue;
    }
    switch (p.type) {
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) return { error: `«${p.label}» debe ser un número` };
        if (p.min !== undefined && n < p.min) return { error: `«${p.label}» debe ser al menos ${p.min}` };
        if (p.max !== undefined && n > p.max) return { error: `«${p.label}» debe ser como máximo ${p.max}` };
        values[p.name] = n;
        break;
      }
      case 'choice':
        if (typeof v !== 'string' || !(p.options ?? []).includes(v)) return { error: `«${p.label}»: elige una de ${(p.options ?? []).join(', ')}` };
        values[p.name] = v;
        break;
      case 'folder':
        try { values[p.name] = fs.dir(String(v)); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
        break;
      case 'file':
        try { values[p.name] = fs.file(String(v)); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
        break;
      default:
        if (typeof v !== 'string' || v.length > 200) return { error: `«${p.label}» no es válido` };
        values[p.name] = v.trim();
    }
  }
  return { values };
}

const SANDBOX = '/usr/bin/sandbox-exec';

/** Perfil de sandbox: todo permitido salvo red y escritura fuera de las carpetas dadas. Rechaza rutas con caracteres que rompan el perfil. */
export function sandboxProfile(writeDirs: string[]): string {
  const dirs = [...writeDirs, tmpdir(), '/private/tmp', '/private/var/folders', '/dev'].map((d) => { try { return realpathSync(d); } catch { return resolve(d); } });
  for (const d of dirs) if (/["\\\n\r]/.test(d)) throw new ScriptError(`Ruta no permitida en el sandbox: ${d}`);
  return `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* ${dirs.map((d) => `(subpath "${d}")`).join(' ')})`;
}

async function execSandboxed(cmd: string, args: string[], opts: { writeDirs: string[]; timeoutMs?: number }): Promise<ExecResult> {
  if (!existsSync(SANDBOX)) return exec(cmd, args, { timeoutMs: opts.timeoutMs }); // sin sandbox-exec: se ejecuta igual (el módulo ya es de confianza)
  return exec(SANDBOX, ['-p', sandboxProfile(opts.writeDirs), cmd, ...args], { timeoutMs: opts.timeoutMs });
}

function makeCtx(deps: Deps, runId: number): ScriptCtx {
  return {
    db: deps.db, config: deps.config,
    fs: new SafeFs(deps.db, deps.config, runId, deps.trashDir ?? defaultTrash()),
    exec, execSandboxed, bin: deps.bin ?? noBin, now: Date.now,
  };
}

export type PlanOutcome = { ok: true; plan: Plan } | { ok: false; error: string };

/** Vista previa: no cambia nada. */
export async function planScript(deps: Deps, id: string, raw: unknown): Promise<PlanOutcome> {
  const def = findScript(id);
  if (!def) return { ok: false, error: 'Ese script no existe' };
  const ctx = makeCtx(deps, 0);
  const params = coerceParams(def, raw, ctx.fs);
  if ('error' in params) return { ok: false, error: params.error };
  const missing = (def.requires ?? []).filter((r) => !ctx.bin(r));
  if (missing.length) return { ok: false, error: `Falta instalar: ${missing.join(', ')}` };
  try {
    const plan = await def.plan(ctx, params.values);
    return { ok: true, plan: { ...plan, lines: plan.lines.slice(0, 40) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type RunOutcome =
  | { ok: true; runId: number; summary: string; lines: string[]; undoable: boolean; ops: number }
  | { ok: false; error: string; runId?: number; undoable?: boolean };

/** Ejecuta: vuelve a planear (el estado pudo cambiar desde la vista previa) y hace solo eso. */
export async function runScript(deps: Deps, id: string, raw: unknown): Promise<RunOutcome> {
  const def = findScript(id);
  if (!def) return { ok: false, error: 'Ese script no existe' };
  const probe = makeCtx(deps, 0);
  const params = coerceParams(def, raw, probe.fs);
  if ('error' in params) return { ok: false, error: params.error };
  const missing = (def.requires ?? []).filter((r) => !probe.bin(r));
  if (missing.length) return { ok: false, error: `Falta instalar: ${missing.join(', ')}` };

  const runId = Number(deps.db.prepare('INSERT INTO script_runs (ts, script, summary) VALUES (?, ?, ?)').run(Date.now(), id, '').lastInsertRowid);
  const ctx = makeCtx(deps, runId);
  const opCount = (): number => (deps.db.prepare('SELECT COUNT(*) AS n FROM script_undo WHERE run_id = ?').get(runId) as { n: number }).n;
  const undoable = (): boolean => opCount() > 0;
  try {
    const plan = await def.plan(probe, params.values);
    const res = plan.count === 0 ? { summary: plan.summary, lines: plan.lines } : await def.run(ctx, params.values, plan); // nada que hacer: no se ejecuta
    deps.db.prepare('UPDATE script_runs SET summary = ? WHERE id = ?').run(res.summary, runId);
    logAudit(deps.db, 'script_run', `${id}: ${res.summary}`.slice(0, 500));
    return { ok: true, runId, summary: res.summary, lines: (res.lines ?? []).slice(0, 40), undoable: undoable(), ops: opCount() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.db.prepare('UPDATE script_runs SET summary = ? WHERE id = ?').run(`Falló: ${msg}`.slice(0, 300), runId);
    logAudit(deps.db, 'script_failed', `${id}: ${msg}`.slice(0, 500));
    return { ok: false, error: msg, runId, undoable: undoable() };
  }
}

export interface RunInfo { id: number; ts: number; script: string; title: string; summary: string; undone: boolean; undoable: boolean }

export function listRuns(db: Db, limit = 10): RunInfo[] {
  const rows = db.prepare(`SELECT r.id, r.ts, r.script, r.summary, r.undone,
      (SELECT COUNT(*) FROM script_undo u WHERE u.run_id = r.id) AS ops FROM script_runs r ORDER BY r.id DESC LIMIT ?`).all(limit) as
    { id: number; ts: number; script: string; summary: string; undone: number; ops: number }[];
  return rows.map((r) => ({ id: r.id, ts: r.ts, script: r.script, title: findScript(r.script)?.title ?? r.script, summary: r.summary, undone: !!r.undone, undoable: r.ops > 0 && !r.undone }));
}

/** Deshace una ejecución: devuelve lo movido a su sitio y manda a la Papelera lo que el script creó. */
export function undoRun(deps: Deps, runId: number): { ok: true; restored: number; skipped: number } | { ok: false; error: string } {
  const run = deps.db.prepare('SELECT undone FROM script_runs WHERE id = ?').get(runId) as { undone: number } | undefined;
  if (!run) return { ok: false, error: 'Esa ejecución no existe' };
  if (run.undone) return { ok: false, error: 'Ya se deshizo' };
  const trash = deps.trashDir ?? defaultTrash();
  const ops = deps.db.prepare('SELECT kind, src, dst FROM script_undo WHERE run_id = ? ORDER BY id DESC').all(runId) as { kind: 'move' | 'create'; src: string | null; dst: string }[];
  let restored = 0;
  let skipped = 0;
  for (const op of ops) {
    try {
      if (op.kind === 'move' && op.src) {
        const inTrash = dirname(op.dst) === resolve(trash);
        const okPath = validatePath(deps.config, op.src);
        if (typeof okPath !== 'string' || (!inTrash && typeof validatePath(deps.config, op.dst) !== 'string') || !existsSync(op.dst) || existsSync(op.src)) { skipped++; continue; }
        mkdirSync(dirname(op.src), { recursive: true });
        renameSync(op.dst, op.src);
        restored++;
      } else if (op.kind === 'create') {
        if (typeof validatePath(deps.config, op.dst) !== 'string' || !existsSync(op.dst)) { skipped++; continue; }
        mkdirSync(trash, { recursive: true });
        let target = join(trash, basename(op.dst));
        for (let n = 2; existsSync(target); n++) target = join(trash, `${basename(op.dst)} (${n})`);
        renameSync(op.dst, target);
        restored++;
      }
    } catch {
      skipped++;
    }
  }
  deps.db.prepare('UPDATE script_runs SET undone = 1 WHERE id = ?').run(runId);
  logAudit(deps.db, 'script_undo', `ejecución ${runId}: ${restored} restaurados, ${skipped} omitidos`);
  return { ok: true, restored, skipped };
}

export { ScriptError };
