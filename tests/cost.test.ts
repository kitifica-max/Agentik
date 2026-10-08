import { describe, it, expect } from 'vitest';
import { memoryDb } from './helpers.js';
import { costUsd, recordUsage, usageTotals, fmtUsd, costReport } from '../src/ai/cost.js';

describe('cost', () => {
  it('Sonnet 5.5: $2 entrada, $10 salida, $0.20 caché leída, $2.50 caché escrita por millón', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(12);
    expect(costUsd('claude-sonnet-5-5', { cache_read_input_tokens: 1e6 })).toBeCloseTo(0.2);
    expect(costUsd('claude-sonnet-5-5', { cache_creation_input_tokens: 1e6 })).toBeCloseTo(2.5);
    expect(costUsd('claude-sonnet-5-5', { input_tokens: null, output_tokens: undefined })).toBe(0);
  });

  it('modelo desconocido usa el precio de Sonnet 5.5', () => {
    expect(costUsd('otro-modelo', { input_tokens: 1e6 })).toBeCloseTo(2);
  });

  it('totales por hoy, 7 días y mes; ignora lo viejo', () => {
    const db = memoryDb();
    const now = new Date(2026, 9, 15, 15, 0, 0); // 15 oct 2026, 15:00
    const ins = db.prepare('INSERT INTO usage (ts, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 0, 0, ?)');
    ins.run(new Date(2026, 9, 15, 9).getTime(), 'm', 0.5); // hoy
    ins.run(new Date(2026, 9, 12, 9).getTime(), 'm', 1); // hace 3 días, mismo mes
    ins.run(new Date(2026, 9, 2, 9).getTime(), 'm', 2); // este mes, fuera de 7 días
    ins.run(new Date(2026, 8, 20, 9).getTime(), 'm', 4); // mes pasado
    const t = usageTotals(db, now);
    expect(t.today).toBeCloseTo(0.5);
    expect(t.week).toBeCloseTo(1.5);
    expect(t.month).toBeCloseTo(3.5);
  });

  it('recordUsage guarda la fila y devuelve el costo', () => {
    const db = memoryDb();
    const c = recordUsage(db, 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 500 });
    expect(c).toBeCloseTo(0.007);
    expect(usageTotals(db).today).toBeCloseTo(0.007);
  });

  it('formato', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.004)).toBe('<$0.01');
    expect(fmtUsd(1.234)).toBe('$1.23');
    expect(costReport({ today: 1, week: 2, month: 3 })).toContain('Hoy: $1.00 · Últimos 7 días: $2.00 · Este mes: $3.00');
  });
});
