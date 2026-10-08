import chokidar, { type FSWatcher } from 'chokidar';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Vigila solo las carpetas autorizadas. Ignora ocultos (.agentik, .git, .env).
export function startFileWatcher(folders: string[], onChange: (path: string) => void): FSWatcher | null {
  const roots = folders.filter((f) => isAbsolute(f)).map((f) => resolve(f));
  if (roots.length === 0) return null;
  const watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    // Solo mira segmentos por debajo de la raíz: una carpeta autorizada dentro de un directorio oculto sigue funcionando.
    ignored: (p: string) => {
      const root = roots.find((r) => isInside(r, resolve(p)));
      if (!root) return false;
      return relative(root, resolve(p)).split(sep).some((seg) => seg.startsWith('.'));
    },
    depth: 5,
  });
  const handle = (path: string) => {
    const abs = resolve(path);
    if (roots.some((r) => isInside(r, abs))) onChange(abs);
  };
  watcher.on('add', handle).on('change', handle).on('unlink', handle);
  return watcher;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
