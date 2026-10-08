import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../shared/types';

export const DEFAULT_EXCLUDED_APPS = ['Bitwarden', '1Password', 'Keychain Access', 'Wallet'];
export const DEFAULT_EXCLUDED_TITLE_PATTERNS = [
  'banco', 'bancaria', 'contraseña', 'password', 'login',
  'bitwarden', '1password', 'keychain', 'salud', 'médico', 'wallet',
];

export const DEFAULT_SHORTCUTS = {
  pause: 'CommandOrControl+Shift+P',
  toggle_bubble: 'Control+Alt+A',
  summary: 'Control+Alt+R',
  new_chat: 'Control+Alt+N',
};

const schema = z.object({
  allowed_folders: z.array(z.string()).default([]),
  excluded_apps: z.array(z.string()).default(DEFAULT_EXCLUDED_APPS),
  excluded_title_patterns: z.array(z.string()).default(DEFAULT_EXCLUDED_TITLE_PATTERNS),
  retention_hours: z.number().positive().default(24),
  suggestion_level: z.enum(['silencio', 'discreto', 'activo']).default('discreto'),
  memory_enabled: z.boolean().default(true),
  memory_max_items_per_request: z.number().int().positive().default(5),
  observer_poll_ms: z.number().int().min(1000).default(5000),
  launch_at_login: z.boolean().default(true),
  custom_rules: z.array(z.object({
    app: z.string().min(1),
    title_contains: z.string().optional(),
    minutes: z.number().positive(),
    message: z.string().min(1).max(300),
  })).default([]),
  shortcuts: z.object({
    pause: z.string().min(1).default(DEFAULT_SHORTCUTS.pause),
    toggle_bubble: z.string().min(1).default(DEFAULT_SHORTCUTS.toggle_bubble),
    summary: z.string().min(1).default(DEFAULT_SHORTCUTS.summary),
    new_chat: z.string().min(1).default(DEFAULT_SHORTCUTS.new_chat),
  }).default({ ...DEFAULT_SHORTCUTS }),
});

export function parseConfig(raw: unknown): Config {
  return schema.parse(raw);
}

export function loadConfig(file: string): Config {
  return parseConfig(JSON.parse(readFileSync(file, 'utf8')));
}

let userConfigPath = '';

export function loadUserConfig(userDataDir: string, bundledFile: string): Config {
  userConfigPath = join(userDataDir, 'config.json');
  if (!existsSync(userConfigPath)) {
    copyFileSync(bundledFile, userConfigPath);
  }
  return loadConfig(userConfigPath);
}

export function saveConfig(config: Config): void {
  if (!userConfigPath) return;
  writeFileSync(userConfigPath, JSON.stringify(config, null, 2), 'utf8');
}
