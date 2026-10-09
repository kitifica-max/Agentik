import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import Papa from 'papaparse';
import type { ScriptDef } from '../types.js';
import { ext, fmtSize, pad, plural } from './util.js';
import { pdfText } from './pdf.js';

const CARPETA = { name: 'carpeta', label: 'Carpeta', type: 'folder' as const, required: true };
const stem = (n: string): string => n.slice(0, n.length - extname(n).length);
const natural = (a: string, b: string): number => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

// ── Unir PDFs ────────────────────────────────────────────────────────────────────────────────
export const pdfUnir: ScriptDef = {
  id: 'pdf-unir', title: 'Unir PDFs', group: 'oficina', risk: 'escribe',
  description: 'Une todos los PDF de una carpeta (en orden de nombre, 2 antes que 10) en uno solo dentro de «Unidos». Los originales no se tocan.',
  params: [CARPETA, { name: 'nombre', label: 'Nombre del PDF resultante', type: 'text', default: 'Unido' }],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const pdfs = ctx.fs.walk(root, { maxDepth: 1 }).filter((f) => !f.isDir && ext(f.name) === 'pdf').sort((a, b) => natural(a.name, b.name));
    const name = safeName(String(p.nombre ?? 'Unido')) || 'Unido';
    return {
      summary: pdfs.length >= 2 ? `${pdfs.length} PDFs → «Unidos/${name}.pdf».` : 'Hacen falta al menos 2 PDFs en la carpeta.',
      lines: pdfs.map((f, i) => `${i + 1}. ${f.name}  (${fmtSize(f.size)})`), count: pdfs.length >= 2 ? pdfs.length : 0, data: { root, name, files: pdfs.map((f) => f.path) },
    };
  },
  async run(ctx, _p, plan) {
    const { root, name, files } = plan.data as { root: string; name: string; files: string[] };
    const out = await PDFDocument.create();
    let pages = 0; const skipped: string[] = [];
    for (const f of files) {
      try {
        const src = await PDFDocument.load(readFileSync(f));
        for (const pg of await out.copyPages(src, src.getPageIndices())) { out.addPage(pg); pages++; }
      } catch { skipped.push(basename(f)); } // cifrado o dañado
    }
    if (pages === 0) throw new Error('No pude leer ningún PDF (¿están protegidos con contraseña?)');
    const dst = ctx.fs.uniqueIn(join(root, 'Unidos'), `${name}.pdf`);
    ctx.fs.writeNew(dst, Buffer.from(await out.save()));
    return { summary: `Listo: ${plural(files.length - skipped.length, 'PDF unido', 'PDFs unidos')} en ${pages} páginas → «${relative(root, dst)}».` + (skipped.length ? ` No pude leer: ${skipped.join(', ')}.` : '') };
  },
};

// ── Dividir un PDF ───────────────────────────────────────────────────────────────────────────
export const pdfDividir: ScriptDef = {
  id: 'pdf-dividir', title: 'Dividir un PDF', group: 'oficina', risk: 'escribe',
  description: 'Parte un PDF en varios, de N páginas cada uno, dentro de una carpeta nueva junto al original.',
  params: [{ name: 'archivo', label: 'PDF', type: 'file', required: true }, { name: 'cada', label: 'Páginas por archivo', type: 'number', default: 1, min: 1, max: 1000 }],
  async plan(ctx, p) {
    const file = String(p.archivo);
    if (ext(file) !== 'pdf') throw new Error('Elige un archivo PDF');
    let total: number;
    try { total = (await PDFDocument.load(readFileSync(file))).getPageCount(); } catch { throw new Error('No pude leer ese PDF (¿tiene contraseña?)'); }
    const each = Number(p.cada);
    const parts: [number, number][] = [];
    for (let a = 0; a < total; a += each) parts.push([a, Math.min(a + each, total) - 1]);
    return {
      summary: parts.length > 1 ? `${total} páginas → ${plural(parts.length, 'archivo', 'archivos')} de hasta ${each}.` : 'El PDF ya cabe en un solo archivo.',
      lines: parts.map(([a, b]) => `${stem(basename(file))}_p${pad(a + 1, 3)}${b > a ? `-p${pad(b + 1, 3)}` : ''}.pdf`), count: parts.length > 1 ? parts.length : 0, data: { file, parts },
    };
  },
  async run(ctx, _p, plan) {
    const { file, parts } = plan.data as { file: string; parts: [number, number][] };
    const src = await PDFDocument.load(readFileSync(file));
    const dir = ctx.fs.uniqueIn(dirname(file), `${stem(basename(file))} (dividido)`);
    for (const [a, b] of parts) {
      const out = await PDFDocument.create();
      for (const pg of await out.copyPages(src, Array.from({ length: b - a + 1 }, (_, i) => a + i))) out.addPage(pg);
      ctx.fs.writeNew(join(dir, `${stem(basename(file))}_p${pad(a + 1, 3)}${b > a ? `-p${pad(b + 1, 3)}` : ''}.pdf`), Buffer.from(await out.save()));
    }
    return { summary: `Listo: ${plural(parts.length, 'archivo creado', 'archivos creados')} en «${basename(dir)}».` };
  },
};

// ── Facturas ─────────────────────────────────────────────────────────────────────────────────
const MES: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

export function parseFactura(text: string): { fecha: string | null; proveedor: string; total: string | null } {
  let fecha: string | null = null;
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  const dmy = /\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/.exec(text); // día/mes/año (formato latino)
  const largo = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${Object.keys(MES).join('|')})\\s+(?:de|del)\\s+(20\\d{2})\\b`, 'i').exec(text);
  const ok = (y: number, m: number, d: number): boolean => m >= 1 && m <= 12 && d >= 1 && d <= 31;
  if (iso && ok(+iso[1]!, +iso[2]!, +iso[3]!)) fecha = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else if (dmy && ok(+dmy[3]!, +dmy[2]!, +dmy[1]!)) fecha = `${dmy[3]}-${pad(+dmy[2]!)}-${pad(+dmy[1]!)}`;
  else if (largo && ok(+largo[3]!, MES[largo[2]!.toLowerCase()]!, +largo[1]!)) fecha = `${largo[3]}-${pad(MES[largo[2]!.toLowerCase()]!)}-${pad(+largo[1]!)}`;

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const prov = lines.find((l) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(l) && !/factura|invoice|recibo|comprobante|fecha|nit|ruc|n[oº.]|p[áa]gina|total|cliente/i.test(l) && l.length <= 60);

  let total: string | null = null;
  for (const m of text.matchAll(/total[^\d\n]{0,25}\$?\s*([\d.,]+\d)/gi)) {
    const raw = m[1]!;
    const n = Number(raw.includes(',') && raw.includes('.') ? (raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '')) : raw.includes(',') ? raw.replace(',', '.') : raw);
    if (Number.isFinite(n) && n > 0) total = n.toFixed(2); // si hay varios "total", gana el último (el final de la factura)
  }
  return { fecha, proveedor: safeName(prov ?? '') || 'Proveedor', total };
}

export const facturas: ScriptDef = {
  id: 'facturas', title: 'Ordenar facturas PDF', group: 'oficina', risk: 'mueve', requires: ['osascript'],
  description: 'Lee cada PDF, encuentra fecha, proveedor y total, y lo guarda como «Facturas/AAAA/MM/AAAA-MM-DD_Proveedor_Total.pdf». Si no está seguro, lo deja en «Facturas/Revisar». Mira la vista previa: son reglas, no magia.',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const pdfs = ctx.fs.walk(root, { maxDepth: 1 }).filter((f) => !f.isDir && ext(f.name) === 'pdf').slice(0, 300);
    const moves: { src: string; dst: string; ok: boolean }[] = [];
    for (const f of pdfs) {
      const info = parseFactura(await pdfText(ctx, f.path));
      if (info.fecha) {
        const [y, m] = info.fecha.split('-');
        moves.push({ src: f.path, ok: true, dst: join(root, 'Facturas', y!, m!, `${info.fecha}_${info.proveedor}${info.total ? `_${info.total}` : ''}.pdf`) });
      } else moves.push({ src: f.path, ok: false, dst: join(root, 'Facturas', 'Revisar', f.name) });
    }
    const ok = moves.filter((m) => m.ok).length;
    return {
      summary: moves.length ? `${ok} de ${moves.length} PDFs reconocidos como factura; ${moves.length - ok} van a «Facturas/Revisar».` : 'No hay PDFs en la carpeta.',
      lines: moves.map((m) => `${basename(m.src)} → ${relative(root, m.dst)}`), count: moves.length, data: { moves },
    };
  },
  async run(ctx, _p, plan) {
    const { moves } = plan.data as { moves: { src: string; dst: string; ok: boolean }[] };
    for (const m of moves) ctx.fs.move(m.src, m.dst);
    return { summary: `Listo: ${plural(moves.length, 'PDF ordenado', 'PDFs ordenados')} en «Facturas».` };
  },
};

// ── Limpiar CSV ──────────────────────────────────────────────────────────────────────────────
export const csvLimpiar: ScriptDef = {
  id: 'csv-limpiar', title: 'Limpiar un CSV', group: 'oficina', risk: 'escribe',
  description: 'Quita espacios sobrantes, filas repetidas o vacías y columnas sin datos. Guarda una copia «_limpio.csv» y te dice los totales de las columnas numéricas.',
  params: [{ name: 'archivo', label: 'Archivo CSV', type: 'file', required: true }],
  async plan(ctx, p) {
    const file = String(p.archivo);
    if (!['csv', 'tsv'].includes(ext(file))) throw new Error('Elige un archivo .csv');
    const parsed = Papa.parse<string[]>(readFileSync(file, 'utf8').replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
    const rawRows = parsed.data as string[][];
    const rows = rawRows.map((r) => r.map((c) => String(c ?? '').trim()));
    const trimmed = rawRows.reduce((n, r, i) => n + r.filter((c, j) => String(c ?? '') !== rows[i]![j]).length, 0);
    if (rows.length === 0) throw new Error('El CSV está vacío');
    const width = Math.max(...rows.map((r) => r.length));
    const norm = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
    const header = norm[0]!;
    const seen = new Set<string>(); const body: string[][] = []; let dups = 0;
    for (const r of norm.slice(1)) { const k = JSON.stringify(r); if (seen.has(k)) { dups++; continue; } seen.add(k); body.push(r); }
    const keep = header.map((_, i) => body.length === 0 || body.some((r) => r[i] !== '')); // sin ningún dato = columna vacía, aunque tenga título
    const emptyCols = keep.filter((k) => !k).length;
    const cols = keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
    const out = [cols.map((i) => header[i]!), ...body.map((r) => cols.map((i) => r[i]!))];
    const totals: string[] = [];
    for (const i of cols) {
      const vals = body.map((r) => r[i]!).filter((v) => v !== '');
      const nums = vals.map((v) => Number(v.replace(/[$€\s]/g, '').replace(/,(?=\d{3}\b)/g, ''))).filter((n) => Number.isFinite(n));
      if (vals.length >= 2 && nums.length / vals.length >= 0.9) totals.push(`${header[i] || `columna ${i + 1}`}: ${Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100}`);
    }
    return {
      summary: dups + emptyCols + trimmed === 0 ? 'El CSV ya está limpio.' : `${rows.length - 1} filas → ${body.length} (${plural(dups, 'repetida', 'repetidas')}); ${plural(emptyCols, 'columna vacía quitada', 'columnas vacías quitadas')}${trimmed ? `; ${plural(trimmed, 'celda con espacios arreglada', 'celdas con espacios arregladas')}` : ''}.`,
      lines: totals.slice(0, 8).map((t) => `Total ${t}`), count: dups + emptyCols + trimmed, data: { file, csv: Papa.unparse(out, { newline: '\n' }) },
    };
  },
  async run(ctx, _p, plan) {
    const { file, csv } = plan.data as { file: string; csv: string };
    const dst = ctx.fs.uniqueIn(dirname(file), `${stem(basename(file))}_limpio.csv`);
    ctx.fs.writeNew(dst, csv + '\n');
    return { summary: `Listo: guardé «${basename(dst)}». ${plan.summary}`, lines: plan.lines };
  },
};

// ── Documentos a texto ───────────────────────────────────────────────────────────────────────
const DOC_EXTS = ['docx', 'doc', 'rtf', 'html', 'htm', 'odt', 'pdf'];
export const docsATexto: ScriptDef = {
  id: 'docs-a-texto', title: 'Documentos a texto', group: 'oficina', risk: 'escribe', requires: ['textutil', 'osascript'],
  description: 'Convierte Word, RTF, HTML, ODT y PDF a archivos .txt dentro de «Texto» (útil para buscar, o para dárselo a un modelo).',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const docs = ctx.fs.walk(root, { skipNames: ['node_modules', 'Texto'] }).filter((f) => !f.isDir && DOC_EXTS.includes(ext(f.name))).slice(0, 500);
    return { summary: docs.length ? `${plural(docs.length, 'documento', 'documentos')} a texto en «Texto».` : 'No hay documentos que convertir.', lines: docs.map((d) => relative(root, d.path)), count: docs.length, data: { root, docs: docs.map((d) => d.path) } };
  },
  async run(ctx, _p, plan) {
    const { root, docs } = plan.data as { root: string; docs: string[] };
    let ok = 0; let fail = 0;
    for (const d of docs) {
      const dst = ctx.fs.uniqueIn(join(root, 'Texto'), `${stem(basename(d))}.txt`);
      if (ext(d) === 'pdf') {
        const t = await pdfText(ctx, d, 5_000_000);
        if (t.trim()) { ctx.fs.writeNew(dst, t); ok++; } else fail++; // sin texto: probablemente escaneado
      } else {
        ctx.fs.mkdir(join(root, 'Texto'));
        const r = await ctx.exec(ctx.bin('textutil')!, ['-convert', 'txt', '-output', dst, d], { timeoutMs: 60_000 });
        if (r.code === 0) { ctx.fs.created(dst); ok++; } else fail++;
      }
    }
    return { summary: `Listo: ${plural(ok, 'documento convertido', 'documentos convertidos')}.` + (fail ? ` ${fail} no tenían texto o no se pudieron leer (¿PDF escaneado?).` : '') };
  },
};

// ── Atajos de macOS ──────────────────────────────────────────────────────────────────────────
export const atajo: ScriptDef = {
  id: 'atajo-macos', title: 'Ejecutar un Atajo de macOS', group: 'todos', risk: 'actua', requires: ['shortcuts'],
  description: 'Ejecuta uno de tus Atajos (la app Atajos de Apple) por nombre. Lo que haga el Atajo depende de cómo lo armaste.',
  params: [{ name: 'nombre', label: 'Nombre del Atajo', type: 'text', required: true }],
  async plan(ctx, p) {
    const r = await ctx.exec(ctx.bin('shortcuts')!, ['list'], { timeoutMs: 20_000 });
    const all = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const name = String(p.nombre);
    const hit = all.find((s) => s.toLowerCase() === name.toLowerCase());
    return hit
      ? { summary: `Ejecutaré tu Atajo «${hit}».`, lines: [], count: 1, data: { name: hit } }
      : { summary: `No encuentro un Atajo llamado «${name}».`, lines: all.slice(0, 25).map((s) => `Disponible: ${s}`), count: 0, data: null };
  },
  async run(ctx, _p, plan) {
    const { name } = plan.data as { name: string };
    const r = await ctx.exec(ctx.bin('shortcuts')!, ['run', name], { timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`El Atajo falló: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    return { summary: `Listo: ejecuté el Atajo «${name}».`, lines: r.stdout.trim() ? [r.stdout.trim().slice(0, 300)] : [] };
  },
};

export const OFICINA: ScriptDef[] = [pdfUnir, pdfDividir, facturas, csvLimpiar, docsATexto, atajo];
