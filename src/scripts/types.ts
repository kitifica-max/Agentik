import type { Db } from '../db/db.js';
import type { Config } from '../shared/types.js';

// Un "script" de la Biblioteca: una tarea repetitiva con vista previa, ejecución y (si mueve o crea archivos) deshacer.
// Contrato: 1) plan() no cambia nada y dice qué haría; 2) run() solo hace lo que plan() mostró; 3) nunca borra
// (lo que sobra va a Revisar o a la Papelera); 4) solo toca carpetas autorizadas y nunca archivos sensibles.

export type ParamType = 'folder' | 'file' | 'text' | 'number' | 'choice';
export interface ParamDef {
  name: string;
  label: string;
  type: ParamType;
  required?: boolean;
  default?: string | number;
  options?: string[]; // choice
  min?: number; // number
  max?: number;
  help?: string;
}
export type Risk = 'lee' | 'escribe' | 'mueve' | 'actua'; // actua = actúa sobre el sistema (p. ej. cierra un proceso)
export type Group = 'todos' | 'diseno' | 'dev' | 'oficina' | 'contenido';
export type ParamValues = Record<string, string | number>;

/** Lo que mostrará la vista previa. `data` es privado del script: run() lo recibe tal cual. */
export interface Plan { summary: string; lines: string[]; count: number; data?: unknown }
export interface RunResult { summary: string; lines?: string[] }

export interface ScriptDef {
  id: string;
  title: string;
  description: string;
  group: Group;
  risk: Risk;
  params: ParamDef[];
  /** Herramienta externa que hace falta (ver modules.ts); si no está, se avisa antes de ejecutar. */
  requires?: string[];
  plan(ctx: ScriptCtx, p: ParamValues): Promise<Plan>;
  run(ctx: ScriptCtx, p: ParamValues, plan: Plan): Promise<RunResult>;
}

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface ScriptCtx {
  db: Db;
  config: Config;
  fs: import('./fsops.js').SafeFs;
  /** Ejecuta un programa SIN shell (sin riesgo de inyección en los argumentos). */
  exec(cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<ExecResult>;
  /** Como exec, pero dentro de un sandbox de macOS: sin red y escribiendo solo en las carpetas indicadas (y /tmp). */
  execSandboxed(cmd: string, args: string[], opts: { writeDirs: string[]; timeoutMs?: number }): Promise<ExecResult>;
  /** Ruta de una herramienta externa (módulo descargado o instalada en el sistema), o null. */
  bin(name: string): string | null;
  now: () => number;
}
