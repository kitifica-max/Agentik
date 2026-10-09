import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { ScriptDef } from '../types.js';
import { fmtSize, hashFile, headHash, ext, ymd, plural } from './util.js';

const CARPETA = { name: 'carpeta', label: 'Carpeta', type: 'folder' as const, required: true };

// ── Organizar por tipo ───────────────────────────────────────────────────────────────────────
export const REGLAS_POR_TIPO: [string, string[]][] = [
  ['Imágenes', ['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp']],
  ['Documentos', ['pdf', 'docx', 'txt', 'md', 'pages']],
  ['Hojas', ['xlsx', 'csv', 'numbers']],
  ['Video', ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v']],
  ['Audio', ['mp3', 'wav', 'm4a', 'flac', 'aac', 'aiff']],
  ['Comprimidos', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz']],
  ['Instaladores', ['dmg', 'pkg']],
];

export const organizarPorTipo: ScriptDef = {
  id: 'organizar-por-tipo', title: 'Organizar por tipo', group: 'todos', risk: 'mueve',
  description: 'Ordena los archivos sueltos de una carpeta en Imágenes, Documentos, Hojas, Video, Audio, Comprimidos e Instaladores. Lo que no encaja se queda donde está. Se puede deshacer.',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const moves: { src: string; dst: string }[] = [];
    let sinRegla = 0;
    for (const f of ctx.fs.walk(root, { maxDepth: 1 })) {
      if (f.isDir) continue;
      const rule = REGLAS_POR_TIPO.find(([, exts]) => exts.includes(ext(f.name)));
      if (rule) moves.push({ src: f.path, dst: join(root, rule[0], f.name) }); else sinRegla++;
    }
    const groups = new Set(moves.map((m) => m.dst.slice(root.length + 1).split('/')[0])).size;
    return {
      summary: moves.length ? `${plural(moves.length, 'archivo', 'archivos')} a ${plural(groups, 'carpeta', 'carpetas')}${sinRegla ? ` (${sinRegla} sin regla se quedan)` : ''}.` : 'No hay archivos sueltos que organizar.',
      lines: moves.map((m) => `${basename(m.src)} → ${relative(root, m.dst).split('/')[0]}`), count: moves.length, data: { root, moves, groups },
    };
  },
  async run(ctx, _p, plan) {
    const { root, moves, groups } = plan.data as { root: string; moves: { src: string; dst: string }[]; groups: number };
    for (const m of moves) ctx.fs.move(m.src, m.dst);
    return { summary: `Listo, organicé ${basename(root)}: ${moves.length} ${moves.length === 1 ? 'archivo' : 'archivos'} en ${groups} ${groups === 1 ? 'carpeta' : 'carpetas'}.` };
  },
};

// ── Duplicados ───────────────────────────────────────────────────────────────────────────────
export const duplicados: ScriptDef = {
  id: 'duplicados', title: 'Duplicados', group: 'todos', risk: 'mueve',
  description: 'Encuentra archivos idénticos (por contenido, no por nombre). Deja el más antiguo y mueve los demás a «Duplicados».',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const files = ctx.fs.walk(root, { skipNames: ['node_modules', 'Duplicados'] }).filter((f) => !f.isDir && f.size > 0);
    const bySize = new Map<number, typeof files>();
    for (const f of files) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
    const moves: { src: string; keep: string; size: number }[] = [];
    for (const same of bySize.values()) {
      if (same.length < 2) continue;
      const byHead = new Map<string, typeof files>();
      for (const f of same) { try { const h = headHash(f.path); byHead.set(h, [...(byHead.get(h) ?? []), f]); } catch { /* ilegible */ } }
      for (const cand of byHead.values()) {
        if (cand.length < 2) continue;
        const byFull = new Map<string, typeof files>();
        for (const f of cand) { try { const h = await hashFile(f.path); byFull.set(h, [...(byFull.get(h) ?? []), f]); } catch { /* ilegible */ } }
        for (const grp of byFull.values()) {
          if (grp.length < 2) continue;
          const sorted = [...grp].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
          for (const dup of sorted.slice(1)) moves.push({ src: dup.path, keep: sorted[0]!.path, size: dup.size });
        }
      }
    }
    const bytes = moves.reduce((n, m) => n + m.size, 0);
    return {
      summary: moves.length ? `${plural(moves.length, 'duplicado', 'duplicados')} (${fmtSize(bytes)} recuperables). Se mueven a «Duplicados»; los originales no se tocan.` : 'No encontré duplicados.',
      lines: moves.map((m) => `${relative(root, m.src)}  =  ${relative(root, m.keep)}`),
      count: moves.length, data: { root, moves, bytes },
    };
  },
  async run(ctx, _p, plan) {
    const { root, moves, bytes } = plan.data as { root: string; moves: { src: string }[]; bytes: number };
    for (const m of moves) ctx.fs.move(m.src, join(root, 'Duplicados', basename(m.src)));
    return { summary: moves.length ? `Listo: moví ${plural(moves.length, 'duplicado', 'duplicados')} a «Duplicados» (${fmtSize(bytes)}).` : 'No había duplicados.' };
  },
};

// ── Pesados y viejos ─────────────────────────────────────────────────────────────────────────
export const pesadosViejos: ScriptDef = {
  id: 'pesados-viejos', title: 'Pesados y viejos', group: 'todos', risk: 'mueve',
  description: 'Archivos grandes que no tocas hace meses, movidos a «Revisar» para que decidas tú.',
  params: [
    CARPETA,
    { name: 'minMB', label: 'Pesan al menos (MB)', type: 'number', default: 100, min: 1, max: 100000 },
    { name: 'dias', label: 'Sin modificar hace (días)', type: 'number', default: 180, min: 1, max: 3650 },
  ],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const minBytes = Number(p.minMB) * 1024 * 1024;
    const limit = ctx.now() - Number(p.dias) * 86400_000;
    const hits = ctx.fs.walk(root, { skipNames: ['node_modules', 'Revisar'] })
      .filter((f) => !f.isDir && f.size >= minBytes && f.mtimeMs < limit)
      .sort((a, b) => b.size - a.size);
    const bytes = hits.reduce((n, f) => n + f.size, 0);
    return {
      summary: hits.length ? `${plural(hits.length, 'archivo', 'archivos')} (${fmtSize(bytes)}) a «Revisar/Pesados y viejos».` : 'No hay archivos así de pesados y viejos.',
      lines: hits.map((f) => `${fmtSize(f.size)}  ${relative(root, f.path)}`),
      count: hits.length, data: { root, files: hits.map((f) => f.path), bytes },
    };
  },
  async run(ctx, _p, plan) {
    const { root, files, bytes } = plan.data as { root: string; files: string[]; bytes: number };
    for (const f of files) ctx.fs.move(f, join(root, 'Revisar', 'Pesados y viejos', basename(f)));
    return { summary: `Listo: ${plural(files.length, 'archivo', 'archivos')} (${fmtSize(bytes)}) en «Revisar/Pesados y viejos».` };
  },
};

// ── Escáner de secretos ──────────────────────────────────────────────────────────────────────
const SECRET_RULES: [string, RegExp][] = [
  ['clave de Anthropic/OpenAI', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/],
  ['token de GitHub', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['clave de AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['token de Slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['clave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['asignación de secreto', /(api[_-]?key|secret|passwd|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{16,}/i],
];
const SENSITIVE_NAMES = [/^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|kdbx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i];
const isSensitiveName = (n: string): boolean => SENSITIVE_NAMES.some((re) => re.test(n)) && !/\.(example|sample|template)$/i.test(n);

export const escanerSecretos: ScriptDef = {
  id: 'escaner-secretos', title: 'Escáner de secretos', group: 'todos', risk: 'lee',
  description: 'Busca claves, tokens y archivos sensibles olvidados en una carpeta. Solo lee: nunca muestra el valor de un secreto, solo dónde está.',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const all = ctx.fs.walk(root, { hidden: true });
    const lines: string[] = [];
    let flagged = 0;
    let scanned = 0;
    for (const f of all) {
      if (f.isDir) continue;
      const rel = relative(root, f.path);
      if (isSensitiveName(f.name)) { lines.push(`${rel}  — archivo sensible (no lo abro)`); flagged++; continue; }
      if (f.size > 1024 * 1024 || scanned >= 5000) continue;
      let text: string;
      try { const buf = readFileSync(f.path); if (buf.includes(0)) continue; text = buf.toString('utf8'); } catch { continue; }
      scanned++;
      const rows = text.split('\n');
      for (let i = 0; i < rows.length && lines.length < 200; i++) {
        const rule = SECRET_RULES.find(([, re]) => re.test(rows[i]!.slice(0, 500)));
        if (rule) { lines.push(`${rel}:${i + 1}  — ${rule[0]}`); flagged++; }
      }
    }
    return {
      summary: flagged ? `${plural(flagged, 'posible secreto', 'posibles secretos')} en ${basename(root)}. Revisa y muévelos a un lugar seguro.` : `No encontré secretos a la vista en ${plural(scanned, 'archivo revisado', 'archivos revisados')}.`,
      lines, count: flagged, data: null,
    };
  },
  async run(ctx, p, plan) { return { summary: plan.summary, lines: plan.lines }; },
};

// ── Capturas de pantalla ─────────────────────────────────────────────────────────────────────
const CAPTURA = /^(captura de pantalla|captura|screenshot|screen shot|schermafbeelding)/i;
export const capturas: ScriptDef = {
  id: 'capturas', title: 'Capturas de pantalla', group: 'todos', risk: 'mueve',
  description: 'Agrupa por mes las capturas de pantalla viejas en «Capturas/AAAA-MM».',
  params: [CARPETA, { name: 'dias', label: 'Con más de (días)', type: 'number', default: 14, min: 0, max: 3650 }],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const limit = ctx.now() - Number(p.dias) * 86400_000;
    const hits = ctx.fs.walk(root, { maxDepth: 1 }).filter((f) => !f.isDir && CAPTURA.test(f.name) && ['png', 'jpg', 'jpeg'].includes(ext(f.name)) && f.mtimeMs < limit);
    const moves = hits.map((f) => { const d = new Date(f.mtimeMs); return { src: f.path, dst: join(root, 'Capturas', ymd(d).slice(0, 7), f.name) }; });
    return {
      summary: moves.length ? `${plural(moves.length, 'captura', 'capturas')} a «Capturas/AAAA-MM».` : 'No hay capturas viejas sueltas.',
      lines: moves.map((m) => `${basename(m.src)} → ${relative(root, m.dst)}`), count: moves.length, data: { moves },
    };
  },
  async run(ctx, _p, plan) {
    const { moves } = plan.data as { moves: { src: string; dst: string }[] };
    for (const m of moves) ctx.fs.move(m.src, m.dst);
    return { summary: `Listo: ${plural(moves.length, 'captura archivada', 'capturas archivadas')}.` };
  },
};

// ── Carpetas vacías ──────────────────────────────────────────────────────────────────────────
function emptyTree(dir: string): boolean {
  let names: string[];
  try { names = readdirSync(dir); } catch { return false; }
  return names.filter((n) => n !== '.DS_Store').every((n) => {
    const full = join(dir, n);
    try { const st = lstatSync(full); return st.isDirectory() && !st.isSymbolicLink() && emptyTree(full); } catch { return false; }
  });
}

export const carpetasVacias: ScriptDef = {
  id: 'carpetas-vacias', title: 'Carpetas vacías', group: 'todos', risk: 'mueve',
  description: 'Mueve las carpetas sin nada dentro a «Revisar/Carpetas vacías».',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const dirs = ctx.fs.walk(root, { dirs: true, skipNames: ['node_modules', 'Revisar'] }).filter((e) => e.isDir && emptyTree(e.path));
    // solo la más externa de cada rama vacía
    const top = dirs.filter((d) => !dirs.some((o) => o !== d && d.path.startsWith(o.path + '/')));
    return {
      summary: top.length ? `${plural(top.length, 'carpeta vacía', 'carpetas vacías')} a «Revisar/Carpetas vacías».` : 'No hay carpetas vacías.',
      lines: top.map((d) => relative(root, d.path)), count: top.length, data: { root, dirs: top.map((d) => d.path) },
    };
  },
  async run(ctx, _p, plan) {
    const { root, dirs } = plan.data as { root: string; dirs: string[] };
    for (const d of dirs) ctx.fs.move(d, join(root, 'Revisar', 'Carpetas vacías', basename(d)));
    return { summary: `Listo: ${plural(dirs.length, 'carpeta movida', 'carpetas movidas')}.` };
  },
};

// ── Descomprimir zips ────────────────────────────────────────────────────────────────────────
const MAX_ZIP = 2 * 1024 ** 3;
export const descomprimirZips: ScriptDef = {
  id: 'descomprimir-zips', title: 'Descomprimir zips', group: 'todos', risk: 'mueve', requires: ['unzip'],
  description: 'Descomprime cada .zip suelto en su propia carpeta y guarda el zip original en «Zips originales».',
  params: [CARPETA],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const zips = ctx.fs.walk(root, { maxDepth: 1 }).filter((f) => !f.isDir && ext(f.name) === 'zip' && f.size <= MAX_ZIP);
    return {
      summary: zips.length ? `${plural(zips.length, 'zip', 'zips')} a descomprimir (cada uno en su carpeta).` : 'No hay zips sueltos.',
      lines: zips.map((z) => `${z.name}  (${fmtSize(z.size)})`), count: zips.length, data: { root, zips: zips.map((z) => z.path) },
    };
  },
  async run(ctx, _p, plan) {
    const { root, zips } = plan.data as { root: string; zips: string[] };
    const unzip = ctx.bin('unzip')!;
    let ok = 0;
    const fails: string[] = [];
    for (const z of zips) {
      const name = basename(z).replace(/\.zip$/i, '');
      const dest = ctx.fs.uniqueIn(root, name);
      const r = await ctx.exec(unzip, ['-qq', '-n', z, '-d', dest], { timeoutMs: 300_000 });
      if (r.code > 1) { fails.push(basename(z)); continue; } // 1 = avisos menores
      ctx.fs.created(dest);
      ctx.fs.move(z, join(root, 'Zips originales', basename(z)));
      ok++;
    }
    return { summary: `Listo: ${plural(ok, 'zip descomprimido', 'zips descomprimidos')}.` + (fails.length ? ` No pude con: ${fails.join(', ')}.` : '') };
  },
};

// ── Puertos ──────────────────────────────────────────────────────────────────────────────────
interface Listener { pid: number; cmd: string; port: number }
async function listeners(ctx: Parameters<ScriptDef['plan']>[0]): Promise<Listener[]> {
  const r = await ctx.exec(ctx.bin('lsof')!, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 20_000 });
  const out: Listener[] = [];
  let pid = 0; let cmd = '';
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) cmd = line.slice(1);
    else if (line.startsWith('n')) { const m = /:(\d+)$/.exec(line); if (m && pid) out.push({ pid, cmd, port: Number(m[1]) }); }
  }
  return out.filter((l, i) => out.findIndex((o) => o.pid === l.pid && o.port === l.port) === i).sort((a, b) => a.port - b.port);
}

export const puertos: ScriptDef = {
  id: 'puertos', title: 'Puertos en uso', group: 'dev', risk: 'lee', requires: ['lsof'],
  description: 'Qué programa tiene abierto cada puerto de tu Mac (útil cuando «el puerto 3000 ya está en uso»).',
  params: [],
  async plan(ctx) {
    const ls = await listeners(ctx);
    return { summary: ls.length ? `${plural(ls.length, 'puerto abierto', 'puertos abiertos')}.` : 'No hay puertos abiertos que pueda ver.', lines: ls.map((l) => `:${l.port}  ${l.cmd}  (pid ${l.pid})`), count: ls.length, data: null };
  },
  async run(_ctx, _p, plan) { return { summary: plan.summary, lines: plan.lines }; },
};

export const cerrarPuerto: ScriptDef = {
  id: 'cerrar-puerto', title: 'Cerrar un puerto', group: 'dev', risk: 'actua', requires: ['lsof'],
  description: 'Cierra (con cortesía, SIGTERM) el programa que ocupa un puerto. Solo procesos tuyos.',
  params: [{ name: 'puerto', label: 'Puerto', type: 'number', required: true, min: 1, max: 65535 }],
  async plan(ctx, p) {
    const hits = (await listeners(ctx)).filter((l) => l.port === Number(p.puerto));
    const mine = hits.filter((l) => { try { process.kill(l.pid, 0); return true; } catch { return false; } });
    return {
      summary: mine.length ? `Cerraría ${mine.map((l) => `${l.cmd} (pid ${l.pid})`).join(', ')}.` : `Nadie tuyo usa el puerto ${p.puerto}.`,
      lines: mine.map((l) => `${l.cmd}  pid ${l.pid}`), count: mine.length, data: { pids: [...new Set(mine.map((l) => l.pid))] },
    };
  },
  async run(_ctx, _p, plan) {
    const { pids } = plan.data as { pids: number[] };
    let n = 0;
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); n++; } catch { /* ya no existe o no es tuyo */ } }
    return { summary: n ? `Listo: pedí cerrar ${plural(n, 'proceso', 'procesos')}.` : 'No había nada que cerrar.' };
  },
};

export const TODOS: ScriptDef[] = [organizarPorTipo, duplicados, pesadosViejos, escanerSecretos, capturas, carpetasVacias, descomprimirZips, puertos, cerrarPuerto];

