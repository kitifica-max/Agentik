import { execFile } from 'node:child_process';
import type { ActiveWindow } from '../shared/types';

const SCRIPT = `
tell application "System Events"
  set p to first application process whose frontmost is true
  set appName to name of p
  set winTitle to ""
  try
    set winTitle to name of front window of p
  end try
  return appName & linefeed & winTitle
end tell`;

export interface ActiveWindowResult {
  window: ActiveWindow | null;
  permissionsOk: boolean;
}

// Lee app y título con AppleScript. Sin Accesibilidad solo llega el nombre de la app.
export function readActiveWindow(): Promise<ActiveWindowResult> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', SCRIPT], { timeout: 2000 }, (err, stdout) => {
      if (err) {
        resolve({ window: null, permissionsOk: false });
        return;
      }
      const [app = '', ...rest] = stdout.trim().split('\n');
      const title = rest.join('\n');
      if (!app) {
        resolve({ window: null, permissionsOk: true });
        return;
      }
      resolve({ window: { app, title }, permissionsOk: true });
    });
  });
}
