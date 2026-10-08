import type { Config } from '../shared/types';

// Minúsculas y sin acentos: "Contraseña" y "contrasena" coinciden.
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function isExcludedWindow(cfg: Pick<Config, 'excluded_apps' | 'excluded_title_patterns'>, app: string, title: string): boolean {
  const a = norm(app);
  if (cfg.excluded_apps.some((x) => norm(x) === a)) return true;
  const t = norm(title);
  return cfg.excluded_title_patterns.some((p) => t.includes(norm(p)));
}

// Archivos que nunca se registran aunque estén en una carpeta autorizada.
const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|kdbx)$/i,
  /id_(rsa|dsa|ecdsa|ed25519)/i,
  /credential|secret|token|password|contrase/i,
  /(^|\/)\.[^/]+/, // archivos y carpetas ocultas
];

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
}
