import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

// Herramientas externas que algunos scripts necesitan. Se buscan primero en la carpeta de módulos de Kogn y luego en el sistema
// (Homebrew incluido). Instalar un módulo es siempre una acción explícita tuya: Kogn no baja nada por su cuenta.
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'];
const WHISPER_MODELS = { base: 'ggml-base.bin', tiny: 'ggml-tiny.bin' } as const;

export function resolveBin(name: string, modulesDir?: string): string | null {
  const m = /^whisper-model-(base|tiny)$/.exec(name);
  if (m) {
    const f = modulesDir ? join(modulesDir, 'whisper', WHISPER_MODELS[m[1] as 'base' | 'tiny']) : '';
    return f && existsSync(f) ? f : null;
  }
  if (!/^[a-z0-9._-]+$/i.test(name)) return null;
  const dirs = modulesDir ? [join(modulesDir, name, 'bin'), ...SYSTEM_DIRS] : SYSTEM_DIRS;
  for (const d of dirs) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface ModuleSpec {
  id: string;
  title: string;
  note: string;
  /** Qué nombre de herramienta resuelve (para saber si ya está instalado). */
  provides: string;
  how: { kind: 'brew'; formula: string } | { kind: 'model'; url: string; sha256: string; bytes: number; file: string };
  sizeLabel: string;
}

// Los modelos de voz son DATOS (no se ejecutan) y se verifican por SHA-256 (el de Hugging Face, ggerganov/whisper.cpp).
export const MODULES: ModuleSpec[] = [
  { id: 'ffmpeg', title: 'ffmpeg', note: 'Comprimir video, extraer audio, hacer GIFs.', provides: 'ffmpeg', how: { kind: 'brew', formula: 'ffmpeg' }, sizeLabel: 'con Homebrew' },
  { id: 'whisper-cli', title: 'whisper.cpp', note: 'Motor de transcripción local.', provides: 'whisper-cli', how: { kind: 'brew', formula: 'whisper.cpp' }, sizeLabel: 'con Homebrew' },
  { id: 'whisper-model-base', title: 'Modelo de voz «base»', note: 'Buen equilibrio de velocidad y calidad.', provides: 'whisper-model-base', sizeLabel: '148 MB',
    how: { kind: 'model', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', bytes: 147951465, file: 'ggml-base.bin' } },
  { id: 'whisper-model-tiny', title: 'Modelo de voz «tiny»', note: 'Más rápido y ligero, menos preciso.', provides: 'whisper-model-tiny', sizeLabel: '78 MB',
    how: { kind: 'model', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin', sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', bytes: 77691713, file: 'ggml-tiny.bin' } },
];

export interface ModuleStatus { id: string; title: string; note: string; installed: boolean; sizeLabel: string }

export function moduleStatus(modulesDir: string): ModuleStatus[] {
  return MODULES.map((m) => ({ id: m.id, title: m.title, note: m.note, sizeLabel: m.sizeLabel, installed: resolveBin(m.provides, modulesDir) !== null }));
}

export type InstallOutcome = { ok: true } | { ok: false; error: string };
export interface InstallDeps {
  modulesDir: string;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
  brew?: string | null;
  onProgress?: (fraction: number) => void;
}

/** Instala un módulo: modelos por descarga verificada, herramientas con Homebrew (que ya debe estar instalado). */
export async function installModule(id: string, deps: InstallDeps): Promise<InstallOutcome> {
  const spec = MODULES.find((m) => m.id === id);
  if (!spec) return { ok: false, error: 'Ese módulo no existe' };
  if (resolveBin(spec.provides, deps.modulesDir)) return { ok: true };

  if (spec.how.kind === 'brew') {
    const brew = deps.brew === undefined ? resolveBin('brew') : deps.brew;
    if (!brew) return { ok: false, error: 'Falta Homebrew (brew.sh). Instálalo y vuelve a intentarlo.' };
    const formula = spec.how.formula;
    return new Promise((done) => {
      execFile(brew, ['install', formula], { timeout: 30 * 60_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1' } }, (err, _o, stderr) => {
        done(err ? { ok: false, error: `Homebrew no pudo instalar ${formula}: ${String(stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)}` } : { ok: true });
      });
    });
  }

  const { url, sha256, bytes, file } = spec.how;
  const dir = join(deps.modulesDir, 'whisper');
  mkdirSync(dir, { recursive: true });
  const part = join(dir, `${file}.part`);
  const doFetch = deps.fetchImpl ?? (async (u: string) => { const r = await fetch(u); return { ok: r.ok, status: r.status, body: r.body }; });
  try {
    const res = await doFetch(url);
    if (!res.ok || !res.body) return { ok: false, error: `La descarga falló (HTTP ${res.status})` };
    const hash = createHash('sha256');
    const out = createWriteStream(part);
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value); got += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
      deps.onProgress?.(Math.min(1, got / bytes));
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    if (got !== bytes || hash.digest('hex') !== sha256) { rmSync(part, { force: true }); return { ok: false, error: 'El archivo descargado no coincide con la suma de verificación; lo descarté.' }; }
    renameSync(part, join(dir, file));
    return { ok: true };
  } catch (e) {
    rmSync(part, { force: true });
    return { ok: false, error: `La descarga falló: ${e instanceof Error ? e.message : String(e)}` };
  }
}

