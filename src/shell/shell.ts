import { spawn } from 'node:child_process';

// ponytail: red de seguridad best-effort contra desastres irreversibles, no un sandbox.
const BLOCKED: RegExp[] = [
  /\bsudo\b/,
  /\bmkfs\b|\bdiskutil\s+(erase|partition|reformat|secure)/i,
  /\bdd\b[^;&|\n]*\bof=\/dev\//,
  /:\(\)\s*\{/,
  /\b(curl|wget)\b[^;&\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
  /\brm\b[^;&|\n]*\s-\w*[rR]\w*[^;&|\n]*\s(\/|~|\$HOME|\/Users(\/[^/\s]+)?|\/(System|Library|Applications|usr|etc|bin|sbin))\/?\*?(\s|$)/,
];

export function isBlockedCommand(command: string): boolean {
  return BLOCKED.some((re) => re.test(command));
}

function clip(s: string): string {
  return s.length > 20_000 ? `${s.slice(0, 8_000)}\n...[recortado]...\n${s.slice(-12_000)}` : s;
}

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let timedOut = false;
    const add = (d: Buffer): void => { if (out.length < 200_000) out += d.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, opts.timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, output: String(e), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: clip(out), timedOut }); });
  });
}
