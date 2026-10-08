import type { Db } from '../db/db.js';

// $ por millón de tokens (precios públicos de Anthropic). Cache write = 5 min (1.25x entrada).
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const FALLBACK = PRICES['claude-sonnet-5-5']!;

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? FALLBACK;
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.output_tokens ?? 0) * p.out +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6
  );
}

export function recordUsage(db: Db, model: string, u: Usage): number {
  const cost = costUsd(model, u);
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
  return `Hoy: ${fmtUsd(t.today)} · Últimos 7 días: ${fmtUsd(t.week)} · Este mes: ${fmtUsd(t.month)}\n(Estimado con los precios públicos de Sonnet 5.5: $2 de entrada y $10 de salida por millón de tokens. Solo cuenta lo gastado desde que se activó este contador.)`;
}
