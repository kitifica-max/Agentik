import type { Db } from '../db/db.js';
import type { ModelProfile } from '../shared/types.js';

// $ por millón de tokens [entrada, salida] (precios públicos de Anthropic).
// Caché leída = 0.1x la entrada; caché escrita (5 min) = 1.25x.
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
  'gpt-oss:20b': [0.07, 0.3], // Ollama Cloud (precio publicado en ollama.com/pricing)
};

export interface Price { in: number; out: number }

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Precio del perfil: los modelos locales (Ollama) cuestan $0; el resto, el que el usuario definió o el de la tabla. */
export function profilePrice(p: ModelProfile): Price | undefined {
  if (p.price_in != null && p.price_out != null) return { in: p.price_in, out: p.price_out };
  if (p.provider !== 'ollama') return undefined;
  // Los modelos "-cloud" corren en servidores de Ollama y sí cobran; los locales cuestan $0.
  const cloud = p.model.endsWith('-cloud');
  return (cloud && priceFor(p.model.replace(/-cloud$/, ''))) || { in: 0, out: 0 };
}

/** Precio efectivo: el del perfil si lo tiene, si no la tabla; modelo desconocido = sin precio (0). */
export function priceFor(model: string, override?: Price): Price | null {
  if (override) return override;
  const p = PRICES[model];
  return p ? { in: p[0], out: p[1] } : null;
}

export function costUsd(model: string, u: Usage, override?: Price): number {
  const p = priceFor(model, override);
  if (!p) return 0;
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.output_tokens ?? 0) * p.out +
      (u.cache_read_input_tokens ?? 0) * p.in * 0.1 +
      (u.cache_creation_input_tokens ?? 0) * p.in * 1.25) / 1e6
  );
}

export function recordUsage(db: Db, model: string, u: Usage, override?: Price): number {
  const cost = costUsd(model, u, override);
  db.prepare(
    'INSERT INTO usage (ts, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(Date.now(), model, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, cost);
  return cost;
}

export interface UsageTotals { today: number; week: number; month: number }

export function usageTotals(db: Db, now: Date = new Date()): UsageTotals {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const month = new Date(day); month.setDate(1);
  const sum = (since: number): number =>
    (db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE ts >= ?').get(since) as { c: number }).c;
  return { today: sum(day.getTime()), week: sum(now.getTime() - 7 * 86400_000), month: sum(month.getTime()) };
}

export function fmtUsd(n: number): string {
  return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

export function costReport(t: UsageTotals): string {
  return `Hoy: ${fmtUsd(t.today)} · Últimos 7 días: ${fmtUsd(t.week)} · Este mes: ${fmtUsd(t.month)}\n(Estimado con los precios de cada modelo; los modelos locales cuestan $0. Solo cuenta lo gastado desde que se activó este contador.)`;
}
