import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Db } from '../db/db.js';
import type { Config } from '../shared/types.js';
import { isWithin, broadFolderReason } from '../shared/paths.js';
import { isSensitivePath } from '../observer/filters.js';
import { logAudit } from '../files/fileTools.js';
import type { Committed } from '../chat/attachments.js';
import { listScripts, runScript, listRuns, undoRun, findScript, type Deps as ScriptDeps } from '../scripts/engine.js';

// Recetas locales: peticiones frecuentes y sin ambigüedad que se resuelven en la Mac, sin llamar al modelo.
// Si el texto no encaja exactamente, no hay coincidencia y sigue el flujo normal con el modelo.

export type RecipeMatch =
  | { id: 'script'; script: string; params: Record<string, string> }
  | { id: 'undo' };
export interface RecipeResult { reply: string; ops: number; action: string }
export interface RecipeDeps { db: Db; config: Config; backupDir?: string; bin?: (name: string) => string | null; trashDir?: string }

const ALIAS: Record<string, string> = { descargas: 'downloads', escritorio: 'desktop', documentos: 'documents' };
const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const DET = new Set(['el', 'la', 'los', 'las', 'estos', 'estas', 'este', 'esta', 'mi', 'mis', 'un', 'una', 'unos', 'unas']);
const squash = (s: string): string => norm(s).split(/\s+/).filter((w) => w && !DET.has(w)).join(' ');

const ORGANIZE = /^\s*(?:organiza|ordena)(?:me)?\s+(?:(?:por favor|pf)\s+)?(?:(?:mi|mis|la|el|las|los)\s+)?(?:carpeta\s+)?(?:de\s+)?(.+?)(?:\s+(?:por favor|pf))?\s*[.!]*\s*$/i;
const UNDO = /^\s*(?:deshaz|deshacer|des-?hacer)(?:\s+(?:eso|lo\s+(?:ultimo|anterior)|la\s+ultima(?:\s+tarea)?))?\s*[.!]*\s*$/i;

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

// Cómo se llama cada script al hablar (además de su id y su título). Solo scripts que no piden nada más que una carpeta.
const SCRIPT_WORDS: Record<string, string[]> = {
  'duplicados': ['duplicados', 'archivos duplicados', 'busca duplicados'],
  'pesados-viejos': ['pesados', 'archivos pesados', 'pesados y viejos'],
  'escaner-secretos': ['secretos', 'escanea secretos', 'busca secretos', 'escaner de secretos'],
  'capturas': ['capturas', 'archiva capturas', 'capturas de pantalla'],
  'carpetas-vacias': ['carpetas vacias', 'busca carpetas vacias'],
  'descomprimir-zips': ['descomprime', 'descomprime zips', 'descomprimir zips', 'zips'],
  'renombrar-fecha': ['renombra por fecha', 'renombrar por fecha'],
  'pdf-unir': ['une pdfs', 'unir pdfs', 'une los pdf'],
  'facturas': ['facturas', 'ordena facturas'],
  'puertos': ['puertos', 'puertos en uso'],
  'repos-estado': ['repos', 'estado de mis repos', 'estado de repos'],
  'node-modules-viejos': ['node modules viejos', 'limpia node modules'],
  'env-example': ['env example', 'crea env example'],
  'docs-a-texto': ['documentos a texto', 'docs a texto'],
  'video-comprimir': ['comprime videos', 'comprimir videos'],
  'audio-extraer': ['extrae audio', 'extraer audio'],
  'imagenes-convertir': ['convierte imagenes', 'convertir imagenes'],
  'imagenes-redimensionar': ['redimensiona imagenes', 'redimensionar imagenes'],
  'pdf-dividir': ['divide', 'divide pdf', 'dividir pdf', 'parte pdf'],
  'csv-limpiar': ['limpia csv', 'limpiar csv'],
  'transcribir': ['transcribe', 'transcribir', 'transcribe audio', 'transcribe video'],
  'video-gif': ['gif', 'haz gif', 'video a gif'],
};

function scriptMatch(text: string, config: Config, att?: Committed): RecipeMatch | null {
  const t = norm(text).replace(/[.!¡?¿]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(?:(?:corre|ejecuta|usa|haz|revisa|busca)\s+)?(?:el script\s+)?(.+?)(?:\s+(?:en|de|sobre|dentro de)\s+(?:la carpeta\s+|mi carpeta\s+|mis\s+|mi\s+|la\s+|el\s+)?(.+))?$/.exec(t);
  if (!m) return null;
  const phrase = squash(m[1]!);
  const info = listScripts().find((s) => [s.id.replace(/-/g, ' '), s.title, ...(SCRIPT_WORDS[s.id] ?? [])].map(squash).includes(phrase));
  if (!info) return null;
  const onlyKnown = info.params.every((p) => ['carpeta', 'archivo'].includes(p.name) || !p.required || p.default !== undefined);
  if (!onlyKnown) return null;
  const params: Record<string, string> = {};
  if (info.params.some((p) => p.name === 'carpeta')) {
    const folder = m[2] ? resolveFolder(m[2], config) : att ? att.dir : null; // sin carpeta explícita, usa la de los adjuntos
    if (!folder) return null;
    params.carpeta = folder;
  } else if (m[2] && !info.params.some((p) => p.name === 'archivo')) return null;
  if (info.params.some((p) => p.name === 'archivo')) {
    if (!att?.files.length) return null; // sin adjunto no hay de qué archivo hablar: que pregunte el modelo
    params.archivo = att.files[0]!.path;
  }
  return { id: 'script', script: info.id, params };
}

export function matchRecipe(text: string, config: Config, att?: Committed): RecipeMatch | null {
  if (typeof text !== 'string' || text.length > 200) return null;
  if (UNDO.test(text)) return { id: 'undo' };
  const scr = scriptMatch(text, config, att);
  if (scr) return scr;
  const m = ORGANIZE.exec(text);
  if (!m) return null;
  const folder = resolveFolder(m[1]!, config);
  return folder ? { id: 'script', script: 'organizar-por-tipo', params: { carpeta: folder } } : null;
}

/** ¿Hay algo reciente que "deshaz" pueda devolver? Si no, la petición pasa al modelo. */
export function canUndo(db: Db): boolean { return listRuns(db, 20).some((r) => r.undoable); }

export async function runRecipe(match: RecipeMatch, deps: RecipeDeps): Promise<RecipeResult> {
  const { db, config } = deps;
  const sd: ScriptDeps = { db, config, bin: deps.bin, trashDir: deps.trashDir };

  if (match.id === 'undo') {
    const last = listRuns(db, 20).find((r) => r.undoable);
    if (!last) return { reply: 'No tengo nada reciente que se pueda deshacer.', ops: 0, action: '' };
    const r = undoRun(sd, last.id);
    logAudit(db, 'recipe', `deshacer ${last.script}`);
    return r.ok
      ? { reply: `Listo, deshice «${last.title}»: ${r.restored} ${r.restored === 1 ? 'cosa devuelta' : 'cosas devueltas'}${r.skipped ? ` (${r.skipped} no se pudieron devolver)` : ''}.`, ops: r.restored, action: `deshacer ${last.script} → ${r.restored} devueltos` }
      : { reply: `No pude deshacer: ${r.error}`, ops: 0, action: '' };
  }

  const def = findScript(match.script);
  const r = await runScript(sd, match.script, match.params);
  logAudit(db, 'recipe', `script ${match.script}`);
  if (!r.ok) return { reply: `No pude: ${r.error}`, ops: 0, action: '' };
  const hint = r.undoable ? ' Si no te gusta, di «deshaz».' : '';
  return { reply: `${r.summary}${hint}`, ops: r.ops, action: `${def?.id ?? match.script} → ${r.summary}`.slice(0, 120) };
}
