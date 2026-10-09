import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, copyFileSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { Db } from '../db/db.js';
import type { Config } from '../shared/types.js';
import { validatePath } from '../files/fileTools.js';
import { isWithin, broadFolderReason, isInsideInternalRoot } from '../shared/paths.js';
import { isSensitivePath } from '../observer/filters.js';

export class ScriptError extends Error {}

export const MAX_WALK = 50_000; // tope de archivos que mira un script (evita colgar la app en discos enormes)

export interface Entry { path: string; name: string; size: number; mtimeMs: number; isDir: boolean }

/**
 * Acceso a archivos para los scripts: valida cada ruta (carpetas autorizadas, nada sensible), nunca pisa un destino
 * existente, nunca borra, y anota cada movimiento/creación para poder deshacerlo.
 * runId = 0 → solo lectura (la vista previa no puede cambiar nada).
 */
export class SafeFs {
  truncated = false;
  constructor(private db: Db, private config: Config, private runId: number, readonly trashDir: string) {}

  /** Ruta válida (autorizada y no sensible) o ScriptError. */
  allowed(p: string): string {
    const r = validatePath(this.config, p);
    if (typeof r !== 'string') throw new ScriptError(r.error);
    return r;
  }

  dir(p: string): string {
    const abs = this.allowed(p);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new ScriptError(`No es una carpeta: ${p}`);
    return abs;
  }

  file(p: string): string {
    const abs = this.allowed(p);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new ScriptError(`No es un archivo: ${p}`);
    return abs;
  }

  /** Recorre una carpeta sin enlaces simbólicos, ocultos ni archivos sensibles. */
  walk(root: string, opts: { maxDepth?: number; dirs?: boolean; skipNames?: string[]; hidden?: boolean } = {}): Entry[] {
    const out: Entry[] = [];
    const skip = new Set(opts.skipNames ?? ['node_modules']);
    const maxDepth = opts.maxDepth ?? Infinity;
    const go = (dir: string, depth: number): void => {
      let names: string[];
      try { names = readdirSync(dir).sort(); } catch { return; }
      for (const name of names) {
        if (out.length >= MAX_WALK) { this.truncated = true; return; }
        if (skip.has(name) || (opts.hidden ? name === '.git' : name.startsWith('.'))) continue;
        const full = join(dir, name);
        if (!opts.hidden && isSensitivePath(full)) continue; // hidden=true es solo para el escáner de secretos, que no lee esos archivos
        let st;
        try { st = lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (opts.dirs) out.push({ path: full, name, size: 0, mtimeMs: st.mtimeMs, isDir: true });
          if (depth < maxDepth) go(full, depth + 1);
        } else if (st.isFile()) {
          out.push({ path: full, name, size: st.size, mtimeMs: st.mtimeMs, isDir: false });
        }
      }
    };
    go(root, 1);
    return out;
  }

  /** Nombre libre en `dir`: "foto.jpg" → "foto (2).jpg" si ya existe. */
  uniqueIn(dir: string, name: string): string {
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let candidate = join(dir, name);
    for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
    return candidate;
  }

  private record(kind: 'move' | 'create', src: string | null, dst: string): void {
    this.db.prepare('INSERT INTO script_undo (run_id, kind, src, dst) VALUES (?, ?, ?, ?)').run(this.runId, kind, src, dst);
  }

  private writable(): void {
    if (this.runId === 0) throw new ScriptError('La vista previa no puede cambiar archivos');
  }

  /** Mueve sin pisar nada; devuelve el destino final. Queda anotado para deshacer. */
  move(src: string, dst: string): string {
    this.writable();
    const a = this.allowed(src);
    const b = this.allowed(dst);
    if (!existsSync(a)) throw new ScriptError(`No existe: ${a}`);
    const target = this.uniqueIn(dirname(b), basename(b));
    mkdirSync(dirname(target), { recursive: true });
    try {
      renameSync(a, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV' && statSync(a).isFile()) { copyFileSync(a, target); unlinkSync(a); } // otro disco: copiar y quitar el original
      else throw e;
    }
    this.record('move', a, target);
    return target;
  }

  /** Anota un archivo o carpeta que el script creó (para poder deshacer). */
  created(dst: string): void {
    this.writable();
    this.record('create', null, this.allowed(dst));
  }

  mkdir(p: string): string {
    this.writable();
    const abs = this.allowed(p);
    mkdirSync(abs, { recursive: true });
    return abs;
  }

  /** Escribe un archivo nuevo (sin pisar) dentro de una carpeta autorizada, aunque su nombre sea "sensible" (p. ej. .env.example). */
  writeNew(p: string, content: string | Buffer): string {
    this.writable();
    const abs = resolve(p);
    if (!isInsideInternalRoot(abs) && !this.config.allowed_folders.some((f) => isAbsolute(f) && !broadFolderReason(f) && isWithin(f, abs))) throw new ScriptError('Fuera de carpetas autorizadas');
    if (existsSync(abs)) throw new ScriptError(`Ya existe: ${abs}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.record('create', null, abs);
    return abs;
  }

  /** A la Papelera con nombre único (nunca borra de verdad). */
  toTrash(p: string): string {
    this.writable();
    const abs = this.allowed(p);
    mkdirSync(this.trashDir, { recursive: true });
    const target = this.uniqueIn(this.trashDir, basename(abs));
    renameSync(abs, target);
    this.record('move', abs, target);
    return target;
  }
}

export function resolveAbs(p: string): string { return resolve(p); }
