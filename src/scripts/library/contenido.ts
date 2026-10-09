import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import type { ScriptDef } from '../types.js';
import { VIDEO_EXTS, ext, fmtSize, plural } from './util.js';

const CARPETA = { name: 'carpeta', label: 'Carpeta', type: 'folder' as const, required: true };
const stem = (n: string): string => n.slice(0, n.length - extname(n).length);
const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'aiff'];

// Los programas externos (ffmpeg, whisper) corren dentro de un sandbox de macOS: sin red y escribiendo solo en su carpeta de salida.

// ── Comprimir video ──────────────────────────────────────────────────────────────────────────
const CRF: Record<string, string> = { alta: '20', media: '24', baja: '28' };
export const videoComprimir: ScriptDef = {
  id: 'video-comprimir', title: 'Comprimir videos', group: 'contenido', risk: 'escribe', requires: ['ffmpeg'],
  description: 'Reduce el peso de los videos de una carpeta a MP4 (H.264) para compartirlos. Las copias van a «Comprimidos»; los originales no se tocan.',
  params: [CARPETA, { name: 'calidad', label: 'Calidad', type: 'choice', options: ['alta', 'media', 'baja'], default: 'media' }],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const vids = ctx.fs.walk(root, { skipNames: ['node_modules', 'Comprimidos'] }).filter((f) => !f.isDir && VIDEO_EXTS.includes(ext(f.name)));
    return {
      summary: vids.length ? `${plural(vids.length, 'video', 'videos')} (${fmtSize(vids.reduce((n, v) => n + v.size, 0))}) a MP4 en «Comprimidos».` : 'No hay videos en la carpeta.',
      lines: vids.map((v) => `${relative(root, v.path)}  (${fmtSize(v.size)})`), count: vids.length, data: { root, crf: CRF[String(p.calidad)] ?? '24', vids: vids.map((v) => ({ path: v.path, size: v.size })) },
    };
  },
  async run(ctx, _p, plan) {
    const { root, crf, vids } = plan.data as { root: string; crf: string; vids: { path: string; size: number }[] };
    const out = join(root, 'Comprimidos');
    ctx.fs.mkdir(out);
    let ok = 0, before = 0, after = 0; const fails: string[] = [];
    for (const v of vids) {
      const dst = ctx.fs.uniqueIn(out, `${stem(basename(v.path))}.mp4`);
      const r = await ctx.execSandboxed(ctx.bin('ffmpeg')!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', v.path, '-c:v', 'libx264', '-crf', crf, '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dst], { writeDirs: [out], timeoutMs: 60 * 60_000 });
      if (r.code === 0) { ctx.fs.created(dst); ok++; before += v.size; after += statSync(dst).size; } else fails.push(basename(v.path));
    }
    return { summary: `Listo: ${plural(ok, 'video comprimido', 'videos comprimidos')}${ok ? ` (${fmtSize(before)} → ${fmtSize(after)})` : ''}.` + (fails.length ? ` Fallaron: ${fails.join(', ')}.` : '') };
  },
};

// ── Extraer audio ────────────────────────────────────────────────────────────────────────────
export const audioExtraer: ScriptDef = {
  id: 'audio-extraer', title: 'Extraer audio de videos', group: 'contenido', risk: 'escribe', requires: ['ffmpeg'],
  description: 'Saca el audio de cada video a M4A o MP3 dentro de «Audio». Los videos no se tocan.',
  params: [CARPETA, { name: 'formato', label: 'Formato', type: 'choice', options: ['m4a', 'mp3'], default: 'm4a' }],
  async plan(ctx, p) {
    const root = String(p.carpeta);
    const vids = ctx.fs.walk(root, { skipNames: ['node_modules', 'Audio'] }).filter((f) => !f.isDir && VIDEO_EXTS.includes(ext(f.name)));
    return { summary: vids.length ? `${plural(vids.length, 'video', 'videos')} → audio ${String(p.formato).toUpperCase()} en «Audio».` : 'No hay videos en la carpeta.', lines: vids.map((v) => relative(root, v.path)), count: vids.length, data: { root, fmt: String(p.formato), vids: vids.map((v) => v.path) } };
  },
  async run(ctx, _p, plan) {
    const { root, fmt, vids } = plan.data as { root: string; fmt: string; vids: string[] };
    const out = join(root, 'Audio');
    ctx.fs.mkdir(out);
    let ok = 0; const fails: string[] = [];
    for (const v of vids) {
      const dst = ctx.fs.uniqueIn(out, `${stem(basename(v))}.${fmt}`);
      const codec = fmt === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2'] : ['-c:a', 'aac', '-b:a', '192k'];
      const r = await ctx.execSandboxed(ctx.bin('ffmpeg')!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', v, '-vn', ...codec, dst], { writeDirs: [out], timeoutMs: 30 * 60_000 });
      if (r.code === 0) { ctx.fs.created(dst); ok++; } else fails.push(basename(v));
    }
    return { summary: `Listo: ${plural(ok, 'audio extraído', 'audios extraídos')}.` + (fails.length ? ` Fallaron: ${fails.join(', ')}.` : '') };
  },
};

// ── Transcribir ──────────────────────────────────────────────────────────────────────────────
export const transcribir: ScriptDef = {
  id: 'transcribir', title: 'Transcribir audio o video', group: 'contenido', risk: 'escribe', requires: ['ffmpeg', 'whisper-cli'],
  description: 'Pasa a texto lo que se dice en un audio o video, con Whisper en tu Mac: nada sale a internet. Guarda el .txt en «Transcripciones».',
  params: [
    { name: 'archivo', label: 'Audio o video', type: 'file', required: true },
    { name: 'idioma', label: 'Idioma', type: 'choice', options: ['auto', 'es', 'en', 'pt', 'fr', 'de', 'it'], default: 'es' },
    { name: 'modelo', label: 'Modelo', type: 'choice', options: ['base', 'tiny'], default: 'base', help: 'base: mejor calidad. tiny: más rápido.' },
  ],
  async plan(ctx, p) {
    const f = String(p.archivo);
    if (![...AUDIO_EXTS, ...VIDEO_EXTS].includes(ext(f))) throw new Error('Elige un archivo de audio o video');
    const model = ctx.bin(`whisper-model-${p.modelo}`);
    if (!model) throw new Error(`Falta el modelo de voz «${p.modelo}». Instálalo en Módulos.`);
    return { summary: `Transcribiré «${basename(f)}» (${fmtSize(statSync(f).size)}) con el modelo ${p.modelo}. Puede tardar varios minutos.`, lines: [], count: 1, data: { file: f, lang: String(p.idioma), model } };
  },
  async run(ctx, _p, plan) {
    const { file, lang, model } = plan.data as { file: string; lang: string; model: string };
    const tmp = mkdtempSync(join(tmpdir(), 'agentik-voz-'));
    try {
      const wav = join(tmp, 'audio.wav');
      const a = await ctx.execSandboxed(ctx.bin('ffmpeg')!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { writeDirs: [tmp], timeoutMs: 30 * 60_000 });
      if (a.code !== 0) throw new Error(`No pude leer el audio: ${a.stderr.trim().slice(0, 150)}`);
      const w = await ctx.execSandboxed(ctx.bin('whisper-cli')!, ['-m', model, '-f', wav, '-l', lang, '-otxt', '-of', join(tmp, 'salida'), '-np'], { writeDirs: [tmp], timeoutMs: 120 * 60_000 });
      if (w.code !== 0) throw new Error(`Whisper falló: ${w.stderr.trim().slice(0, 150)}`);
      const text = readFileSync(join(tmp, 'salida.txt'), 'utf8').trim();
      if (!text) return { summary: 'No detecté voz en ese archivo.' };
      const dst = ctx.fs.uniqueIn(join(file, '..', 'Transcripciones'), `${stem(basename(file))}.txt`);
      ctx.fs.writeNew(dst, text + '\n');
      return { summary: `Listo: «${basename(dst)}» en «Transcripciones» (${plural(text.split(/\s+/).length, 'palabra', 'palabras')}).`, lines: [text.slice(0, 300)] };
    } finally { rmSync(tmp, { recursive: true, force: true }); } // carpeta temporal que creó este script
  },
};

// ── Video a GIF ──────────────────────────────────────────────────────────────────────────────
export const videoGif: ScriptDef = {
  id: 'video-gif', title: 'Video a GIF', group: 'contenido', risk: 'escribe', requires: ['ffmpeg'],
  description: 'Convierte el inicio de un video en un GIF animado, dentro de «GIFs» junto al video.',
  params: [
    { name: 'archivo', label: 'Video', type: 'file', required: true },
    { name: 'ancho', label: 'Ancho (px)', type: 'number', default: 480, min: 120, max: 1280 },
    { name: 'segundos', label: 'Duración máxima (s)', type: 'number', default: 8, min: 1, max: 60 },
  ],
  async plan(_ctx, p) {
    const f = String(p.archivo);
    if (!VIDEO_EXTS.includes(ext(f))) throw new Error('Elige un archivo de video');
    return { summary: `GIF de hasta ${p.segundos} s a ${p.ancho}px de «${basename(f)}».`, lines: [], count: 1, data: { file: f, w: Number(p.ancho), s: Number(p.segundos) } };
  },
  async run(ctx, _p, plan) {
    const { file, w, s } = plan.data as { file: string; w: number; s: number };
    const out = join(file, '..', 'GIFs');
    ctx.fs.mkdir(out);
    const dst = ctx.fs.uniqueIn(out, `${stem(basename(file))}.gif`);
    const r = await ctx.execSandboxed(ctx.bin('ffmpeg')!, ['-hide_banner', '-loglevel', 'error', '-y', '-t', String(s), '-i', file, '-vf', `fps=12,scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, '-loop', '0', dst], { writeDirs: [out], timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Error(`ffmpeg falló: ${r.stderr.trim().slice(0, 150)}`);
    ctx.fs.created(dst);
    return { summary: `Listo: «${basename(dst)}» (${fmtSize(statSync(dst).size)}).` };
  },
};

export const CONTENIDO: ScriptDef[] = [videoComprimir, audioExtraer, transcribir, videoGif];
