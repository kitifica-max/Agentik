import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { rm, readdir, statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Db } from '../db/db.js';
import { logAudit } from '../files/fileTools.js';
import { runCommand } from '../shell/shell.js';

const MB = 1024 * 1024;
const REPORT_TTL_MS = 15 * 60_000;

export interface DiskItem {
  id: number;
  label: string;
  path: string;
  bytes: number;
  safe: boolean; // regenerable: se puede borrar sin perder trabajo
  kind: 'cache' | 'dev' | 'trash' | 'big';
}

export interface DiskReport {
  items: DiskItem[];
  ts: number;
  snapshots: number;
  freeBytes: number;
  home: string;
}

export interface ScanOpts {
  home?: string;
  roots?: string[];
  minBytes?: number;
  bigBytes?: number;
  dormantDays?: number;
}

let last: DiskReport | null = null;

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const sh = async (cmd: string, secs = 60): Promise<string> =>
  (await runCommand(cmd, { cwd: '/', timeoutMs: secs * 1000 })).output;

async function sizeOf(p: string): Promise<number> {
  const kb = parseInt(await sh(`du -sk ${q(p)} 2>/dev/null | tail -1`), 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

// du -k imprime "KB<TAB>ruta"
function parseDu(out: string): { bytes: number; path: string }[] {
  return out.split('\n').flatMap((l) => {
    const i = l.indexOf('\t');
    const kb = parseInt(l.slice(0, i), 10);
    return i > 0 && Number.isFinite(kb) ? [{ bytes: kb * 1024, path: l.slice(i + 1) }] : [];
  });
}

async function inChunks<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...(await Promise.all(xs.slice(i, i + n).map(fn))));
  return out;
}

export async function scanDisk(opts: ScanOpts = {}): Promise<DiskReport> {
  const home = opts.home ?? homedir();
  const min = opts.minBytes ?? 100 * MB;
  const big = opts.bigBytes ?? 300 * MB;
  const days = opts.dormantDays ?? 30;
  const roots = (opts.roots ?? []).filter((r) => existsSync(r));
  const found: Omit<DiskItem, 'id'>[] = [];

  const fixed: [string, string, DiskItem['kind']][] = [
    ['Caché de npm', join(home, '.npm/_cacache'), 'cache'],
    ['Caché de compilación de Xcode', join(home, 'Library/Developer/Xcode/DerivedData'), 'cache'],
    ['Datos de dispositivos de Xcode', join(home, 'Library/Developer/Xcode/iOS DeviceSupport'), 'cache'],
    ['Registros del sistema', join(home, 'Library/Logs'), 'cache'],
    ['Papelera', join(home, '.Trash'), 'trash'],
  ];

  const cachesDir = join(home, 'Library/Caches');
  const [fixedSizes, cacheOut, devOut, bigOut, snapOut, fs] = await Promise.all([
    Promise.all(fixed.map(([, p]) => (existsSync(p) ? sizeOf(p) : Promise.resolve(0)))),
    existsSync(cachesDir) ? sh(`du -sk ${q(cachesDir)}/* 2>/dev/null | sort -rn | head -12`) : Promise.resolve(''),
    roots.length
      ? sh(`find ${roots.map(q).join(' ')} -maxdepth 6 -type d \\( -name node_modules -o -name .next -o -name .turbo -o -name .nuxt \\) -prune -print 2>/dev/null | head -60`, 90)
      : Promise.resolve(''),
    roots.length
      ? sh(`find ${roots.map(q).join(' ')} -type f -size +${Math.max(1, Math.ceil(big / MB))}M -not -path '*/node_modules/*' -not -path '*/.git/*' -exec du -k {} + 2>/dev/null | sort -rn | head -8`, 90)
      : Promise.resolve(''),
    sh('tmutil listlocalsnapshots / 2>/dev/null | grep -c com.apple', 20),
    statfs('/').catch(() => null),
  ]);

  fixed.forEach(([label, path, kind], i) => {
    if (fixedSizes[i]! >= min) found.push({ label, path, bytes: fixedSizes[i]!, safe: true, kind });
  });
  for (const c of parseDu(cacheOut)) {
    const name = basename(c.path);
    if (c.bytes >= min && !name.startsWith('com.apple.')) found.push({ label: `Caché de ${name}`, path: c.path, bytes: c.bytes, safe: true, kind: 'cache' });
  }

  const dirs = devOut.split('\n').filter(Boolean);
  const dormant = (await inChunks(dirs, 6, async (d) => {
    const parent = dirname(d);
    const active = await sh(
      `find ${q(parent)} -maxdepth 3 \\( -name node_modules -o -name .next -o -name .turbo -o -name .nuxt \\) -prune -o -type f -mtime -${days} -print -quit 2>/dev/null`,
    );
    return active.trim() ? null : d;
  })).filter((d): d is string => d !== null);
  const dormantSizes = await inChunks(dormant, 6, sizeOf);
  dormant.forEach((d, i) => {
    if (dormantSizes[i]! >= min) {
      found.push({ label: `${basename(d)} de ${short(dirname(d), home)} (sin uso hace más de ${days} días)`, path: d, bytes: dormantSizes[i]!, safe: true, kind: 'dev' });
    }
  });

  for (const b of parseDu(bigOut)) found.push({ label: basename(b.path), path: b.path, bytes: b.bytes, safe: false, kind: 'big' });

  found.sort((a, b) => Number(b.safe) - Number(a.safe) || b.bytes - a.bytes);
  last = {
    items: found.map((it, i) => ({ ...it, id: i + 1 })),
    ts: Date.now(),
    snapshots: parseInt(snapOut, 10) || 0,
    freeBytes: fs ? fs.bavail * fs.bsize : 0,
    home,
  };
  return last;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / MB))} MB`;
}

const short = (p: string, home: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

export function formatReport(r: DiskReport): string {
  const safe = r.items.filter((i) => i.safe);
  const mine = r.items.filter((i) => !i.safe);
  const out = [`Tienes ${fmtBytes(r.freeBytes)} libres en el disco.`];
  if (safe.length) {
    out.push(`Puedo liberar ${fmtBytes(safe.reduce((s, i) => s + i.bytes, 0))} sin tocar tus archivos:`);
    safe.forEach((i, n) => out.push(`${n + 1}. ${i.label}: ${fmtBytes(i.bytes)}`));
    out.push('Escribe "limpia" para liberarlo.');
  } else {
    out.push('No encontré nada seguro de limpiar automáticamente.');
  }
  if (mine.length) {
    out.push('Tus archivos que más pesan (decides tú):');
    mine.forEach((i) => out.push(`• ${i.label}: ${fmtBytes(i.bytes)} (${short(dirname(i.path), r.home)})`));
  }
  if (r.snapshots > 0) out.push(`Time Machine guarda ${r.snapshots} copias locales; macOS las libera solo cuando falta espacio.`);
  return out.join('\n');
}

// Solo borra lo regenerable del último reporte, dentro del home, y nunca archivos del usuario.
export async function cleanLast(db: Db): Promise<string> {
  if (!last || Date.now() - last.ts > REPORT_TTL_MS) return 'Primero escribe "espacio" para revisar qué se puede limpiar.';
  const { home } = last;
  const safe = last.items.filter((i) => i.safe);
  if (safe.length === 0) return 'No hay nada seguro de limpiar.';

  let freed = 0;
  const failed: string[] = [];
  for (const it of safe) {
    const p = resolve(it.path);
    if (!p.startsWith(home + sep) || !existsSync(p)) continue;
    try {
      if (it.kind === 'trash') {
        for (const e of await readdir(p)) await rm(join(p, e), { recursive: true, force: true });
      } else {
        await rm(p, { recursive: true, force: true });
      }
      freed += it.bytes;
      logAudit(db, 'disk_clean', `${p} (${fmtBytes(it.bytes)})`);
    } catch (e) {
      failed.push(it.label);
      logAudit(db, 'disk_clean_failed', `${p}: ${e instanceof Error ? e.message : e}`);
    }
  }
  last = null;
  const now = await statfs('/').catch(() => null);
  const freeNow = now ? ` Ahora tienes ${fmtBytes(now.bavail * now.bsize)} libres.` : '';
  return `Liberé ${fmtBytes(freed)}.${freeNow}` + (failed.length ? ` No pude limpiar: ${failed.join(', ')}.` : '');
}
