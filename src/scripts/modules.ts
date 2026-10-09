import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Dónde buscar herramientas externas: primero los módulos que Agentik descargó, luego el sistema.
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'];

export function resolveBin(name: string, modulesDir?: string): string | null {
  if (!/^[a-z0-9._-]+$/i.test(name)) return null;
  const dirs = modulesDir ? [join(modulesDir, name, 'bin'), join(modulesDir, name), ...SYSTEM_DIRS] : SYSTEM_DIRS;
  for (const d of dirs) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}
