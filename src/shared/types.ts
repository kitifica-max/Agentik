export type CharacterState =
  | 'reposo'
  | 'observando'
  | 'pensando'
  | 'con-sugerencia'
  | 'esperando-aprobacion'
  | 'pausado'
  | 'exito'
  | 'confuso';

export interface ObserverStatus {
  enabled: boolean;
  paused: boolean;
  permissionsOk: boolean;
}

export interface ActiveWindow {
  app: string;
  title: string;
}

export interface CustomRule {
  app: string;
  title_contains?: string;
  minutes: number;
  message: string;
}

export interface Shortcuts {
  pause: string;
  toggle_bubble: string;
  summary: string;
  new_chat: string;
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
  custom_rules: CustomRule[];
  shortcuts: Shortcuts;
  launch_at_login: boolean;
}

export interface NewEvent {
  ts: number;
  kind: 'app_focus' | 'file_change';
  app?: string | null;
  title?: string | null;
  path?: string | null;
  duration_ms?: number | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type MemoryTipo = 'preferencia' | 'proyecto' | 'decisión' | 'contexto';
export type MemoryEstado = 'propuesto' | 'aprobado' | 'rechazado';

export type FileEditStatus = 'propuesto' | 'aprobado' | 'rechazado' | 'aplicado' | 'fallido';

export interface FileEdit {
  id: number;
  ts: number;
  path: string;
  status: FileEditStatus;
  backup_path: string | null;
  diff: string | null;
}

export interface Memory {
  id: number;
  contenido: string;
  tipo: MemoryTipo;
  fuente: string;
  estado: MemoryEstado;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}
