import { createHash } from 'node:crypto';
import { createReadStream, readSync, openSync, closeSync } from 'node:fs';
import { extname } from 'node:path';

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const ext = (name: string): string => extname(name).slice(1).toLowerCase();
export const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Hash completo, leyendo en flujo (no carga el archivo entero en memoria). */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Hash rápido de los primeros 64 KB: descarta casi todos los distintos sin leer el archivo entero. */
export function headHash(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return createHash('sha256').update(buf.subarray(0, n)).digest('hex');
  } finally { closeSync(fd); }
}

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'gif', 'webp'];
export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm'];
