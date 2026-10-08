import type { Db } from '../db/db.js';
import type { Config } from '../shared/types.js';

export interface Suggestion {
  id: string;
  text: string;
  rule: string;
  ts: number;
}

type Level = Config['suggestion_level'];

const COOLDOWN_MS: Record<Level, number> = {
  silencio: Infinity,
  discreto: 15 * 60_000,
  activo: 5 * 60_000,
};

const MIN_EVENTS = 3;

interface EventRow {
  ts: number;
  kind: string;
  app: string | null;
  title: string | null;
  path: string | null;
  duration_ms: number | null;
}

export class SuggestionEngine {
  private lastSuggestionTs = 0;
  private lastDismissedRule = '';
  private idCounter = 0;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  evaluate(now: number = Date.now()): Suggestion | null {
    const level = this.config.suggestion_level;
    if (level === 'silencio') return null;

    if (now - this.lastSuggestionTs < COOLDOWN_MS[level]) return null;

    const since = now - 2 * 3600_000;
    const events = this.db.prepare(
      'SELECT ts, kind, app, title, path, duration_ms FROM events WHERE ts > ? ORDER BY ts DESC LIMIT 100',
    ).all(since) as EventRow[];

    if (events.length < MIN_EVENTS) return null;

    const suggestion =
      this.checkLongFocus(events, now) ??
      this.checkRapidSwitching(events, now) ??
      (level === 'activo' ? this.checkRepeatedEdits(events, now) : null) ??
      (level === 'activo' ? this.checkInactivity(events, now) : null);

    if (!suggestion || suggestion.rule === this.lastDismissedRule) return null;

    this.lastSuggestionTs = now;
    this.lastDismissedRule = '';
    return suggestion;
  }

  dismiss(rule: string): void {
    this.lastDismissedRule = rule;
  }

  // ponytail: exposed for tests
  get _lastTs(): number { return this.lastSuggestionTs; }

  private makeId(): string {
    return `s_${++this.idCounter}_${Date.now()}`;
  }

  private checkLongFocus(events: EventRow[], now: number): Suggestion | null {
    const focus = events.filter(e => e.kind === 'app_focus' && e.app);
    if (focus.length < 2) return null;

    const app = focus[0]!.app;
    let totalMs = 0;
    for (const e of focus) {
      if (e.app !== app) break;
      totalMs += e.duration_ms ?? 0;
    }

    if (totalMs < 30 * 60_000) return null;

    return {
      id: this.makeId(),
      text: `Llevas ${Math.round(totalMs / 60_000)} min en ${app}. ¿Necesitas un descanso o ayuda con algo?`,
      rule: 'long_focus',
      ts: now,
    };
  }

  private checkRapidSwitching(events: EventRow[], now: number): Suggestion | null {
    const cutoff = now - 5 * 60_000;
    const recent = events.filter(e => e.kind === 'app_focus' && e.ts > cutoff && e.app);
    const apps = new Set(recent.map(e => e.app));

    if (apps.size < 5) return null;

    return {
      id: this.makeId(),
      text: 'Muchos cambios de app. ¿Puedo ayudarte a concentrarte en algo?',
      rule: 'rapid_switching',
      ts: now,
    };
  }

  private checkRepeatedEdits(events: EventRow[], now: number): Suggestion | null {
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.kind === 'file_change' && e.path) {
        counts.set(e.path, (counts.get(e.path) ?? 0) + 1);
      }
    }

    for (const [path, count] of counts) {
      if (count >= 3) {
        const name = path.split('/').pop() ?? path;
        return {
          id: this.makeId(),
          text: `${name} modificado ${count} veces. ¿Quieres que revise los cambios?`,
          rule: 'repeated_edits',
          ts: now,
        };
      }
    }
    return null;
  }

  private checkInactivity(events: EventRow[], now: number): Suggestion | null {
    if (events.length < 5) return null;
    const latest = events[0]!.ts + (events[0]!.duration_ms ?? 0);
    const gap = now - latest;

    if (gap < 10 * 60_000 || gap > 30 * 60_000) return null;

    return {
      id: this.makeId(),
      text: '¿Sigues ahí? Puedo resumir lo que estabas haciendo.',
      rule: 'inactivity',
      ts: now,
    };
  }
}
