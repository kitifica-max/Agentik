import type { Db } from '../db/db.js';

interface Row { kind: string; app: string | null; path: string | null; duration_ms: number | null }

function fmt(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const m = min % 60;
  return m ? `${Math.floor(min / 60)} h ${m} min` : `${Math.floor(min / 60)} h`;
}

// Sin modelo: solo agrega los eventos que el observador ya guardó.
export function dailySummary(db: Db, hours = 24, now = Date.now()): string {
  const rows = db.prepare(
    'SELECT kind, app, path, duration_ms FROM events WHERE ts > ?',
  ).all(now - hours * 3600_000) as Row[];

  const focus = rows.filter((r) => r.kind === 'app_focus' && r.app);
  const changes = rows.filter((r) => r.kind === 'file_change' && r.path);
  if (focus.length === 0 && changes.length === 0) {
    return `Sin actividad registrada en las últimas ${hours} h. Activa el observador para tener resumen.`;
  }

  const byApp = new Map<string, number>();
  let total = 0;
  let longest = { app: '', ms: 0 };
  for (const r of focus) {
    const ms = r.duration_ms ?? 0;
    total += ms;
    byApp.set(r.app!, (byApp.get(r.app!) ?? 0) + ms);
    if (ms > longest.ms) longest = { app: r.app!, ms };
  }
  const apps = [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).filter(([, ms]) => ms >= 60_000);

  const perFile = new Map<string, number>();
  for (const r of changes) perFile.set(r.path!, (perFile.get(r.path!) ?? 0) + 1);
  const top = [...perFile.entries()].sort((a, b) => b[1] - a[1])[0];

  const out = [`Resumen de las últimas ${hours} h:`];
  if (total > 0) out.push(`• Tiempo registrado: ${fmt(total)}`);
  if (apps.length) out.push(`• Apps: ${apps.map(([a, ms]) => `${a} ${fmt(ms)}`).join(', ')}`);
  if (focus.length > 1) out.push(`• Cambios de app: ${focus.length - 1}`);
  if (longest.ms >= 60_000) out.push(`• Sesión más larga: ${longest.app}, ${fmt(longest.ms)}`);
  if (perFile.size) {
    out.push(`• Archivos modificados: ${perFile.size}` + (top && top[1] > 1 ? ` (más editado: ${top[0].split('/').pop()}, ${top[1]} veces)` : ''));
  }
  return out.join('\n');
}
