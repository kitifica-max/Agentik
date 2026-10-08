import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

// Claves de API cifradas con el llavero del sistema (Electron safeStorage). Nunca van a la base
// de datos, al config.json, a los logs ni a la ventana de la interfaz.
export interface Crypto {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export class SecretStore {
  constructor(private file: string, private crypto: Crypto) {}

  private read(): Record<string, string> {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  private write(all: Record<string, string>): void {
    writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  has(id: string): boolean {
    return !!this.read()[id];
  }

  get(id: string): string | null {
    const v = this.read()[id];
    if (!v) return null;
    try { return this.crypto.decrypt(Buffer.from(v, 'base64')); } catch { return null; }
  }

  set(id: string, key: string): void {
    const clean = key.trim();
    if (!clean) throw new Error('La API key está vacía');
    if (!this.crypto.isAvailable()) throw new Error('El cifrado del sistema (Llavero) no está disponible; no guardo la clave sin cifrar.');
    const all = this.read();
    all[id] = this.crypto.encrypt(clean).toString('base64');
    this.write(all);
  }

  delete(id: string): void {
    const all = this.read();
    if (!(id in all)) return;
    delete all[id];
    this.write(all);
  }
}
