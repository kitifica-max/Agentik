import chokidar, { type FSWatcher } from 'chokidar';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { broadFolderReason } from '../shared/paths.js';

// Vigila solo las carpetas autorizadas. Ignora ocultos (.agentik, .git, .env).
export function startFileWatcher(folders: string[], onChange: (path: string) => void): FSWatcher | null {
  // Nunca vigila carpetas demasiado amplias (disco entero, sistema...): sería inviable y peligroso.
  const roots = folders.filter((f) => isAbsolute(f) && !broadFolderReason(f)).map((f) => resolve(f));
  if (roots.length === 0) return null;
  const watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    // Solo mira segmentos por debajo de la raíz: una carpeta autorizada dentro de un directorio oculto sigue funcionando.
    ignored: (p: string) => {
      const root = roots.find((r) => isInside(r, resolve(p)));
      if (!root) return false;
      return relative(root, resolve(p)).split(sep).some((seg) => seg.startsWith('.') || seg === 'node_modules');
    },
    depth: 5,
  });
  const handle = (path: string) => {
    const abs = resolve(path);
    if (roots.some((r) => isInside(r, abs))) onChange(abs);
  };
  watcher.on('add', handle).on('change', handle).on('unlink', handle);
  // Un error del vigilante (permisos, demasiados archivos abiertos...) se registra y se sigue: antes tumbaba la app.
  watcher.on('error', (e) => console.warn('[agentik] vigilante de archivos:', e instanceof Error ? e.message : e));
  return watcher;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
