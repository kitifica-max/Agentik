export type CharacterState =
  | 'reposo'
  | 'observando'
  | 'pensando'
  | 'con-sugerencia'
  | 'esperando-aprobacion'
  | 'pausado';

export interface ObserverStatus {
  enabled: boolean;
  paused: boolean;
  permissionsOk: boolean;
}

export interface ActiveWindow {
  app: string;
  title: string;
}

export interface Config {
  allowed_folders: string[];
  excluded_apps: string[];
  excluded_title_patterns: string[];
  retention_hours: number;
  suggestion_level: 'silencio' | 'discreto' | 'activo';
  memory_enabled: boolean;
  memory_max_items_per_request: number;
  observer_poll_ms: number;
}

export interface NewEvent {
  ts: number;
  kind: 'app_focus' | 'file_change';
  app?: string | null;
  title?: string | null;
  path?: string | null;
  duration_ms?: number | null;
}
