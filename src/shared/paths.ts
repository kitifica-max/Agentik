import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** ¿`target` es `root` o está dentro? Respeta los límites de carpeta: /a/Down no abarca /a/Downloads2. */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

const canonical = (p: string): string => {
  try { return realpathSync.native(p); } catch { return resolve(p); } // sigue enlaces: "Macintosh HD" apunta a "/"
};

// Estas carpetas, ellas mismas, son demasiado amplias (sus subcarpetas sí se pueden usar)...
const EXACT = ['/', '/Users', '/Volumes', '/Applications', '/private', '/private/var', '/private/tmp', '/opt', '/home', '/net'];
// ...y estas, junto con todo lo que cuelga de ellas, son del sistema.
const TREE = ['/System', '/bin', '/sbin', '/usr', '/private/etc', '/dev', '/cores', '/Library'];

/**
 * Si dar acceso a esta carpeta sería peligroso o inviable (disco entero, sistema, tu carpeta personal completa...)
 * devuelve el motivo; si es una carpeta razonable, null. Autorizar una carpeta le da al agente permiso para
 * leer, mover y escribir ahí, y hace que Agentik vigile todo lo que cambie dentro.
 */
export function broadFolderReason(folder: string, home: string = homedir()): string | null {
  if (!isAbsolute(folder)) return 'no es una ruta absoluta';
  const p = canonical(folder);
  const h = canonical(home);
  if (p === '/') return 'es todo el disco';
  if (/^\/Volumes\/[^/]+$/.test(p)) return 'es un disco completo';
  if (p === h) return 'es toda tu carpeta personal';
  if (isWithin(join(h, 'Library'), p)) return 'es Library, donde las apps guardan sus datos';
  if (EXACT.includes(p) || TREE.some((t) => isWithin(t, p))) return 'es una carpeta del sistema';
  return null;
}

/** Quita de la lista las carpetas demasiado amplias. Devuelve las que se quedan y las que se quitaron con su motivo. */
export function sanitizeFolders(folders: string[], home: string = homedir()): { kept: string[]; removed: { path: string; reason: string }[] } {
  const kept: string[] = [];
  const removed: { path: string; reason: string }[] = [];
  for (const f of folders) {
    const reason = broadFolderReason(f, home);
    if (reason) removed.push({ path: f, reason });
    else if (!kept.includes(f)) kept.push(f);
  }
  return { kept, removed };
}
