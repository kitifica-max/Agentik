import type { Db } from '../db/db.js';

interface EventRow {
  kind: string;
  app: string | null;
  title: string | null;
  path: string | null;
  duration_ms: number | null;
}

export function recentEventsSummary(db: Db, hoursBack: number = 2, maxLines: number = 20): string {
  const since = Date.now() - hoursBack * 3600_000;
  const rows = db.prepare(
    'SELECT kind, app, title, path, duration_ms FROM events WHERE ts > ? ORDER BY ts DESC LIMIT 100',
  ).all(since) as EventRow[];

  if (rows.length === 0) return '';

  const appTime = new Map<string, number>();
  const files: string[] = [];

  for (const r of rows) {
    if (r.kind === 'app_focus' && r.app) {
      appTime.set(r.app, (appTime.get(r.app) ?? 0) + (r.duration_ms ?? 0));
    }
    if (r.kind === 'file_change' && r.path && !files.includes(r.path)) {
      files.push(r.path);
    }
  }

  const lines: string[] = ['Actividad reciente del usuario:'];

  const sorted = [...appTime.entries()].sort((a, b) => b[1] - a[1]);
  for (const [appName, ms] of sorted.slice(0, 5)) {
    const mins = Math.round(ms / 60_000);
    if (mins > 0) lines.push(`- ${appName}: ${mins} min`);
  }

  if (files.length > 0) {
    lines.push('Archivos modificados:');
    for (const f of files.slice(0, maxLines - lines.length)) {
      lines.push(`- ${f}`);
    }
  }

  return lines.slice(0, maxLines).join('\n');
}
