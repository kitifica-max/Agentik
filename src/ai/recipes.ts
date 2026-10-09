import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Db } from '../db/db.js';
import type { Config } from '../shared/types.js';
import { isWithin, broadFolderReason } from '../shared/paths.js';
import { isSensitivePath } from '../observer/filters.js';
import { organizeFolder, logAudit } from '../files/fileTools.js';

// Recetas locales: peticiones frecuentes y sin ambigüedad que se resuelven en la Mac, sin llamar al modelo.
// Si el texto no encaja exactamente, no hay coincidencia y sigue el flujo normal con el modelo.

export interface RecipeMatch { id: 'organize'; folder: string }
export interface RecipeResult { reply: string; ops: number; action: string }

export const DEFAULT_RULES = [
  { extensions: ['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp'], dest: 'Imágenes' },
  { extensions: ['pdf', 'docx', 'txt', 'md', 'pages'], dest: 'Documentos' },
  { extensions: ['xlsx', 'csv', 'numbers'], dest: 'Hojas' },
  { extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'], dest: 'Video' },
  { extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'aiff'], dest: 'Audio' },
  { extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'], dest: 'Comprimidos' },
  { extensions: ['dmg', 'pkg'], dest: 'Instaladores' },
];

const ALIAS: Record<string, string> = { descargas: 'downloads', escritorio: 'desktop', documentos: 'documents' };
const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const ORGANIZE = /^\s*(?:organiza|ordena)(?:me)?\s+(?:(?:por favor|pf)\s+)?(?:(?:mi|mis|la|el|las|los)\s+)?(?:carpeta\s+)?(?:de\s+)?(.+?)(?:\s+(?:por favor|pf))?\s*[.!]*\s*$/i;

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function allowedDirs(config: Config): string[] {
  return config.allowed_folders.filter((f) => isAbsolute(f) && !broadFolderReason(f)).map((f) => resolve(f));
}

/** Resuelve lo que el usuario escribió a una carpeta autorizada (por nombre, alias o ruta); null si no hay una clara. */
function resolveFolder(target: string, config: Config): string | null {
  const dirs = allowedDirs(config);
  let t = target.trim().replace(/^["'`]|["'`]$/g, '');
  if (t.startsWith('~/')) t = resolve(homedir(), t.slice(2));
  if (isAbsolute(t)) {
    const abs = resolve(t);
    return dirs.some((d) => isWithin(d, abs)) && !isSensitivePath(abs) && isDir(abs) ? abs : null;
  }
  const want = norm(t);
  const hits = dirs.filter((d) => {
    const b = norm(basename(d));
    return b === want || b === ALIAS[want];
  });
  if (hits.length !== 1) return null; // ninguna o ambigua: que decida el modelo
  const abs = hits[0]!;
  return !isSensitivePath(abs) && isDir(abs) ? abs : null;
}

export function matchRecipe(text: string, config: Config): RecipeMatch | null {
  if (typeof text !== 'string' || text.length > 200) return null;
  const m = ORGANIZE.exec(text);
  if (!m) return null;
  const folder = resolveFolder(m[1]!, config);
  return folder ? { id: 'organize', folder } : null;
}

export function runRecipe(match: RecipeMatch, db: Db, config: Config, backupDir: string): RecipeResult {
  const name = basename(match.folder);
  const r = organizeFolder(db, config, backupDir, match.folder, DEFAULT_RULES, 'none');
  const groups = Object.keys(r.byDest).length;
  logAudit(db, 'recipe', `organizar ${match.folder} → ${r.moved} movidos`);
  const action = `organize_folder ${name} → ${r.moved} movidos`;
  if (r.moved === 0 && r.errors.length) return { reply: `No pude organizar ${name}: ${r.errors[0]}`, ops: 0, action: '' };
  if (r.moved === 0) return { reply: `No encontré archivos sueltos que organizar en ${name}.`, ops: 0, action: '' };
  const left = r.errors.length ? ` ${r.errors.length} quedaron sin mover.` : '';
  return { reply: `Listo, organicé ${name}: ${r.moved} ${r.moved === 1 ? 'archivo' : 'archivos'} en ${groups} ${groups === 1 ? 'carpeta' : 'carpetas'}.${left}`, ops: r.moved, action };
}
