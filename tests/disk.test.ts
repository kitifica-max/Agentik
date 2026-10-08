import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb } from './helpers.js';
import { scanDisk, cleanLast, formatReport } from '../src/disk/disk.js';

const MB = 1024 * 1024;
const old = new Date(Date.now() - 90 * 86400_000);
let base: string, home: string, code: string, outside: string;

function file(p: string, mb: number, mtime?: Date): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.alloc(mb * MB, 1));
  if (mtime) utimesSync(p, mtime, mtime);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'agentik-disk-'));
  home = join(base, 'home');
  code = join(home, 'code');
  outside = join(base, 'afuera');
  file(join(home, 'Library/Caches/com.foo.app/data'), 2);
  file(join(home, 'Library/Caches/com.apple.x/data'), 2);
  file(join(home, '.npm/_cacache/x'), 2);
  file(join(home, '.Trash/viejo.bin'), 2);
  file(join(code, 'dormant/package.json'), 0, old);
  file(join(code, 'dormant/node_modules/pkg/index.js'), 2, old);
  file(join(code, 'active/node_modules/pkg/index.js'), 2);
  file(join(code, 'active/src.js'), 0);
  file(join(code, 'video.mov'), 5);
  file(join(outside, 'dormant2/package.json'), 0, old);
  file(join(outside, 'dormant2/node_modules/pkg/index.js'), 2, old);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('disk', () => {
  it('cleanLast sin escaneo previo pide escanear', async () => {
    expect(await cleanLast(memoryDb())).toContain('espacio');
  });

  it('escanea y clasifica regenerable vs archivos del usuario', async () => {
    const r = await scanDisk({ home, roots: [code, outside], minBytes: 1 * MB, bigBytes: 3 * MB });
    const labels = r.items.map((i) => i.label);
    expect(labels).toContain('Caché de com.foo.app');
    expect(labels).not.toContain('Caché de com.apple.x');
    expect(labels).toContain('Caché de npm');
    expect(labels).toContain('Papelera');
    expect(labels.some((l) => l.startsWith('node_modules de ') && l.includes('/code/dormant '))).toBe(true);
    expect(labels.some((l) => l.includes('/code/active '))).toBe(false);
    const video = r.items.find((i) => i.label === 'video.mov');
    expect(video?.safe).toBe(false);
    expect(formatReport(r)).toContain('Escribe "limpia"');
  }, 30_000);

  it('limpia solo lo seguro dentro del home', async () => {
    await scanDisk({ home, roots: [code, outside], minBytes: 1 * MB, bigBytes: 3 * MB });
    const msg = await cleanLast(memoryDb());
    expect(msg).toContain('Liberé');
    expect(existsSync(join(home, 'Library/Caches/com.foo.app'))).toBe(false);
    expect(existsSync(join(home, '.npm/_cacache'))).toBe(false);
    expect(readdirSync(join(home, '.Trash'))).toEqual([]);
    expect(existsSync(join(code, 'dormant/node_modules'))).toBe(false);
    expect(existsSync(join(code, 'active/node_modules'))).toBe(true);
    expect(existsSync(join(code, 'video.mov'))).toBe(true);
    expect(existsSync(join(home, 'Library/Caches/com.apple.x'))).toBe(true);
    expect(existsSync(join(outside, 'dormant2/node_modules'))).toBe(true);
  }, 30_000);
});
