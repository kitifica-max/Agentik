import { basename, extname, join, relative } from 'node:path';
import type { ScriptDef, ScriptCtx } from '../types.js';
import { IMAGE_EXTS, VIDEO_EXTS, ext, pad, plural } from './util.js';

const CARPETA = { name: 'carpeta', label: 'Carpeta', type: 'folder' as const, required: true };
const stem = (name: string): string => name.slice(0, name.length - extname(name).length);

// ── Convertir imágenes ───────────────────────────────────────────────────────────────────────
export const imagenesConvertir: ScriptDef = {
  id: 'imagenes-convertir', title: 'Convertir imágenes', group: 'diseno', risk: 'escribe', requires: ['sips'],
  description: 'Convierte por lote HEIC, PNG, TIFF y otros a JPG o PNG. Las copias van a «Convertidas»; los originales no se tocan.',
  params: [
    CARPETA,
    { name: 'formato', label: 'Formato de salida', type: 'choice', options: ['jpg', 'png'], default: 'jpg', required: true },
    { name: 'calidad', label: 'Calidad JPG (10-100)', type: 'number', default: 85, min: 10, max: 100 },
  ],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const to = String(p.formato);
    const files = ctx.fs.walk(root, { skipNames: ['node_modules', 'Convertidas'] }).filter((f) => !f.isDir && IMAGE_EXTS.includes(ext(f.name)) && !(to === 'jpg' ? ['jpg', 'jpeg'] : ['png']).includes(ext(f.name)));
    const jobs = files.map((f) => ({ src: f.path, size: f.size }));
    return {
      summary: jobs.length ? `${plural(jobs.length, 'imagen', 'imágenes')} a ${to.toUpperCase()} en «Convertidas».` : 'No hay imágenes que convertir.',
      lines: jobs.map((j) => `${relative(root, j.src)} → ${to}`), count: jobs.length, data: { root, to, quality: Number(p.calidad), jobs },
    };
  },
  async run(ctx, _p, plan) {
    const { root, to, quality, jobs } = plan.data as { root: string; to: string; quality: number; jobs: { src: string }[] };
    const sips = ctx.bin('sips')!;
    let ok = 0; let fail = 0;
    for (const j of jobs) {
      const dst = ctx.fs.uniqueIn(join(root, 'Convertidas'), `${stem(basename(j.src))}.${to}`);
      ctx.fs.mkdir(join(root, 'Convertidas'));
      const args = to === 'jpg' ? ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), j.src, '--out', dst] : ['-s', 'format', 'png', j.src, '--out', dst];
      const r = await ctx.exec(sips, args, { timeoutMs: 120_000 });
      if (r.code === 0) { ctx.fs.created(dst); ok++; } else fail++;
    }
    return { summary: `Listo: ${plural(ok, 'imagen convertida', 'imágenes convertidas')} a ${to.toUpperCase()}.` + (fail ? ` ${fail} fallaron.` : '') };
  },
};

// ── Redimensionar imágenes ───────────────────────────────────────────────────────────────────
async function dims(ctx: ScriptCtx, file: string): Promise<[number, number] | null> {
  const r = await ctx.exec(ctx.bin('sips')!, ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeoutMs: 20_000 });
  const w = /pixelWidth:\s*(\d+)/.exec(r.stdout); const h = /pixelHeight:\s*(\d+)/.exec(r.stdout);
  return w && h ? [Number(w[1]), Number(h[1])] : null;
}

export const imagenesRedimensionar: ScriptDef = {
  id: 'imagenes-redimensionar', title: 'Redimensionar imágenes', group: 'diseno', risk: 'escribe', requires: ['sips'],
  description: 'Reduce por lote las imágenes cuyo lado más largo pase de un tamaño. Las copias van a «Redimensionadas»; no agranda ninguna.',
  params: [CARPETA, { name: 'lado', label: 'Lado más largo (px)', type: 'number', default: 1600, min: 100, max: 10000 }],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const max = Number(p.lado);
    const files = ctx.fs.walk(root, { skipNames: ['node_modules', 'Redimensionadas'] }).filter((f) => !f.isDir && IMAGE_EXTS.includes(ext(f.name)));
    const jobs: { src: string; w: number; h: number }[] = [];
    for (const f of files.slice(0, 2000)) {
      const d = await dims(ctx, f.path);
      if (d && Math.max(d[0], d[1]) > max) jobs.push({ src: f.path, w: d[0], h: d[1] });
    }
    return {
      summary: jobs.length ? `${plural(jobs.length, 'imagen', 'imágenes')} pasan de ${max}px y se reducen en «Redimensionadas».` : `Ninguna imagen pasa de ${max}px.`,
      lines: jobs.map((j) => `${relative(root, j.src)}  ${j.w}×${j.h}`), count: jobs.length, data: { root, max, jobs },
    };
  },
  async run(ctx, _p, plan) {
    const { root, max, jobs } = plan.data as { root: string; max: number; jobs: { src: string }[] };
    const sips = ctx.bin('sips')!;
    let ok = 0; let fail = 0;
    for (const j of jobs) {
      ctx.fs.mkdir(join(root, 'Redimensionadas'));
      const dst = ctx.fs.uniqueIn(join(root, 'Redimensionadas'), basename(j.src));
      const r = await ctx.exec(sips, ['-Z', String(max), j.src, '--out', dst], { timeoutMs: 120_000 });
      if (r.code === 0) { ctx.fs.created(dst); ok++; } else fail++;
    }
    return { summary: `Listo: ${plural(ok, 'imagen reducida', 'imágenes reducidas')} a ${max}px.` + (fail ? ` ${fail} fallaron.` : '') };
  },
};

// ── Renombrar por fecha ──────────────────────────────────────────────────────────────────────
const YA_FECHADO = /^\d{4}-\d{2}-\d{2}_\d{6}/;
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function captureDate(ctx: ScriptCtx, file: string, fallbackMs: number): Promise<Date> {
  const mdls = ctx.bin('mdls');
  if (mdls) {
    const r = await ctx.exec(mdls, ['-name', 'kMDItemContentCreationDate', '-raw', file], { timeoutMs: 10_000 });
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(r.stdout.trim());
    if (m) { const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]!.slice(0, 3)}:${m[7]!.slice(3)}`); if (!Number.isNaN(d.getTime())) return d; }
  }
  return new Date(fallbackMs);
}

export const renombrarFecha: ScriptDef = {
  id: 'renombrar-fecha', title: 'Renombrar por fecha', group: 'diseno', risk: 'mueve',
  description: 'Renombra fotos y videos con su fecha de captura: «IMG_1234.HEIC» → «2026-10-09_140322.HEIC». Se puede deshacer.',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const files = ctx.fs.walk(root, { maxDepth: 1 }).filter((f) => !f.isDir && [...IMAGE_EXTS, ...VIDEO_EXTS].includes(ext(f.name)) && !YA_FECHADO.test(f.name)).slice(0, 1500);
    const taken = new Set<string>();
    const jobs: { src: string; name: string }[] = [];
    for (const f of files) {
      const base = stamp(await captureDate(ctx, f.path, f.mtimeMs));
      const e = extname(f.name).toLowerCase();
      let name = `${base}${e}`;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}${e}`;
      taken.add(name);
      jobs.push({ src: f.path, name });
    }
    return {
      summary: jobs.length ? `${plural(jobs.length, 'archivo', 'archivos')} se renombran con su fecha.` : 'No hay fotos o videos por renombrar.',
      lines: jobs.map((j) => `${basename(j.src)} → ${j.name}`), count: jobs.length, data: { root, jobs },
    };
  },
  async run(ctx, _p, plan) {
    const { root, jobs } = plan.data as { root: string; jobs: { src: string; name: string }[] };
    for (const j of jobs) ctx.fs.move(j.src, join(root, j.name));
    return { summary: `Listo: ${plural(jobs.length, 'archivo renombrado', 'archivos renombrados')}.` };
  },
};

export const IMAGENES: ScriptDef[] = [imagenesConvertir, imagenesRedimensionar, renombrarFecha];

