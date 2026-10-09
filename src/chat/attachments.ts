import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { isSensitivePath } from '../observer/filters.js';

// Archivos adjuntos al chat. Se COPIAN a una zona interna de la app (en APFS la copia es instantánea y no ocupa espacio extra
// hasta que cambie), así los originales nunca se tocan y los scripts y el modelo trabajan sobre esa copia. La zona se limpia sola.
export const MAX_FILES = 10;
export const MAX_BYTES = 1.5 * 1024 ** 3;
export const KEEP_MS = 14 * 86400_000;

export interface Attached { id: string; name: string; path: string; size: number; ext: string }
export interface Committed { dir: string; files: Attached[] }
export interface Rejected { name: string; reason: string }

const fmt = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);

export class Attachments {
  private drafts = new Map<number, Attached[]>();
  constructor(readonly root: string, private now: () => number = Date.now) {}

  private draftDir(conv: number): string { return join(this.root, `c${conv}`, 'borrador'); }

  list(conv: number): Attached[] { return this.drafts.get(conv) ?? []; }

  /** Copia los archivos al borrador de esa conversación. Rechaza (con motivo) lo sensible, lo enorme y lo que pase del tope. */
  stage(conv: number, sources: string[]): { files: Attached[]; rejected: Rejected[] } {
    const have = [...this.list(conv)];
    const added: Attached[] = [];
    const rejected: Rejected[] = [];
    const dir = this.draftDir(conv);
    for (const src of sources.slice(0, 50)) {
      if (typeof src !== 'string' || !src) continue;
      const abs = resolve(src);
      const name = basename(abs).replace(/[\\/\n\r]+/g, '_') || 'archivo';
      let st;
      try { st = statSync(abs); } catch { rejected.push({ name, reason: 'no existe' }); continue; }
      if (!st.isFile()) { rejected.push({ name, reason: 'solo se pueden adjuntar archivos, no carpetas' }); continue; }
      if (isSensitivePath(abs)) { rejected.push({ name, reason: 'es un archivo sensible' }); continue; }
      if (st.size > MAX_BYTES) { rejected.push({ name, reason: `pesa más de ${fmt(MAX_BYTES)}` }); continue; }
      if (have.length + added.length >= MAX_FILES) { rejected.push({ name, reason: `máximo ${MAX_FILES} archivos por mensaje` }); continue; }
      mkdirSync(dir, { recursive: true });
      let dst = join(dir, name);
      for (let n = 2; existsSync(dst); n++) dst = join(dir, `${basename(name, extname(name))} (${n})${extname(name)}`);
      try { copyFileSync(abs, dst, constants.COPYFILE_FICLONE); } catch { rejected.push({ name, reason: 'no pude copiarlo' }); continue; }
      added.push({ id: randomUUID().slice(0, 8), name: basename(dst), path: dst, size: st.size, ext: extname(name).slice(1).toLowerCase() });
    }
    this.drafts.set(conv, [...have, ...added]);
    return { files: added, rejected };
  }

  remove(conv: number, id: string): boolean {
    const cur = this.list(conv);
    const f = cur.find((x) => x.id === id);
    if (!f) return false;
    rmSync(f.path, { force: true }); // es una copia nuestra
    this.drafts.set(conv, cur.filter((x) => x.id !== id));
    return true;
  }

  /** Al enviar: el borrador pasa a ser la carpeta de ese mensaje. */
  commit(conv: number): Committed | null {
    const files = this.list(conv);
    if (!files.length) return null;
    const dir = join(this.root, `c${conv}`, `m${this.now()}`);
    mkdirSync(join(this.root, `c${conv}`), { recursive: true });
    renameSync(this.draftDir(conv), dir);
    this.drafts.delete(conv);
    return { dir, files: files.map((f) => ({ ...f, path: join(dir, basename(f.path)) })) };
  }

  clearDrafts(): void {
    for (const conv of this.drafts.keys()) rmSync(this.draftDir(conv), { recursive: true, force: true });
    this.drafts.clear();
  }

  purgeConversation(conv: number): void {
    this.drafts.delete(conv);
    rmSync(join(this.root, `c${conv}`), { recursive: true, force: true });
  }

  purgeAll(): void {
    this.drafts.clear();
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Borra lo viejo (y cualquier borrador que quedó de otra sesión). */
  purgeOld(maxAgeMs = KEEP_MS): number {
    let n = 0;
    if (!existsSync(this.root)) return 0;
    for (const c of readdirSync(this.root)) {
      const cdir = join(this.root, c);
      let subs: string[];
      try { subs = readdirSync(cdir); } catch { continue; }
      for (const m of subs) {
        const p = join(cdir, m);
        let old = m === 'borrador';
        try { old = old || this.now() - statSync(p).mtimeMs > maxAgeMs; } catch { continue; }
        if (old) { rmSync(p, { recursive: true, force: true }); n++; }
      }
      try { if (readdirSync(cdir).length === 0) rmSync(cdir, { recursive: true, force: true }); } catch { /* ya no está */ }
    }
    return n;
  }
}

/** Texto que ve el modelo: dónde están los adjuntos y cómo usarlos. */
export function describeAttachments(att: Committed): string {
  return [
    `[Archivos adjuntos por el usuario en este mensaje — carpeta: ${att.dir}]`,
    ...att.files.map((f) => `- ${f.path} (${f.ext || 'sin extensión'}, ${fmt(f.size)})`),
    'Son copias: puedes leerlas con read_file o procesarlas con run_script (usa la carpeta para scripts de carpeta, o el archivo para los de un archivo). Los resultados se guardan junto a ellas. PDF y Word: docs-a-texto los pasa a texto para leerlos.',
  ].join('\n');
}

export const namesLine = (files: Attached[]): string => `📎 ${files.map((f) => f.name).join(', ')}`;
