import type { Db } from '../db/db';
import { getState, setState } from '../db/db';
import type { ActiveWindow, Config, ObserverStatus } from '../shared/types';
import { isExcludedWindow } from './filters';
import { recordEvent } from './recorder';

const SELF_APPS = ['Electron', 'Kogn', 'Agentik', 'Agetik']; // el nombre actual y los anteriores
const MAX_TITLE = 200;

export type WindowReader = () => Promise<{ window: ActiveWindow | null; permissionsOk: boolean }>;

interface Segment {
  key: string;
  app: string;
  title: string;
  start: number;
}

// Observador de app en primer plano. Nunca guarda nada si está desactivado o en pausa.
export class Observer {
  private segment: Segment | null = null;
  private permissionsOk = true;
  private enabled: boolean;
  private paused: boolean;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly readWindow: WindowReader,
    private readonly onChange: (s: ObserverStatus) => void = () => {},
  ) {
    this.enabled = getState(db, 'enabled') === '1';
    this.paused = getState(db, 'paused') === '1';
  }

  status(): ObserverStatus {
    return { enabled: this.enabled, paused: this.paused, permissionsOk: this.permissionsOk };
  }

  setEnabled(on: boolean): ObserverStatus {
    this.enabled = on;
    setState(this.db, 'enabled', on ? '1' : '0');
    if (!on) this.segment = null;
    return this.emit();
  }

  togglePause(): ObserverStatus {
    this.paused = !this.paused;
    setState(this.db, 'paused', this.paused ? '1' : '0');
    // Pausa inmediata: el segmento abierto se descarta, no se guarda.
    this.segment = null;
    return this.emit();
  }

  get isActive(): boolean {
    return this.enabled && !this.paused;
  }

  // Llamado por el timer cada observer_poll_ms. `now` inyectable para pruebas.
  async tick(now: number = Date.now()): Promise<void> {
    if (!this.isActive) {
      this.segment = null;
      return;
    }
    const { window: win, permissionsOk } = await this.readWindow();
    if (permissionsOk !== this.permissionsOk) {
      this.permissionsOk = permissionsOk;
      this.emit();
    }
    // Re-chequeo tras el await: si pausaron mientras leíamos, no registrar.
    if (!this.isActive) {
      this.segment = null;
      return;
    }
    if (!win || SELF_APPS.includes(win.app)) {
      this.flush(now);
      return;
    }
    if (isExcludedWindow(this.cfg, win.app, win.title)) {
      this.flush(now);
      return;
    }
    const title = win.title.slice(0, MAX_TITLE);
    const key = `${win.app}\u0000${title}`;
    if (this.segment?.key === key) return;
    this.flush(now);
    this.segment = { key, app: win.app, title, start: now };
  }

  // Cierra el segmento actual y lo guarda con su duración.
  private flush(now: number): void {
    if (!this.segment) return;
    const s = this.segment;
    this.segment = null;
    recordEvent(this.db, this.cfg, {
      ts: s.start,
      kind: 'app_focus',
      app: s.app,
      title: s.title,
      duration_ms: now - s.start,
    });
  }

  // Eventos de archivo llegan del watcher; mismo filtro que las ventanas.
  recordFileChange(path: string, now: number = Date.now()): void {
    if (!this.isActive) return;
    recordEvent(this.db, this.cfg, { ts: now, kind: 'file_change', path });
  }

  private emit(): ObserverStatus {
    const s = this.status();
    this.onChange(s);
    return s;
  }
}
