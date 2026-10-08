import { describe, expect, it } from 'vitest';
import { isExcludedWindow, isSensitivePath } from '../src/observer/filters';
import { cfg } from './helpers';

describe('filtros de ventana', () => {
  it('excluye apps listadas', () => {
    expect(isExcludedWindow(cfg, 'Bitwarden', 'Vault')).toBe(true);
    expect(isExcludedWindow(cfg, 'bitwarden', 'Vault')).toBe(true);
  });

  it('excluye títulos con patrones por defecto, sin importar acentos ni mayúsculas', () => {
    expect(isExcludedWindow(cfg, 'Safari', 'Cambiar CONTRASEÑA de Gmail')).toBe(true);
    expect(isExcludedWindow(cfg, 'Safari', 'Consulta medico')).toBe(true);
    expect(isExcludedWindow(cfg, 'Safari', 'Mi banco en línea')).toBe(true);
  });

  it('deja pasar ventanas normales', () => {
    expect(isExcludedWindow(cfg, 'Visual Studio Code', 'observer.ts — Agentik')).toBe(false);
  });
});

describe('filtros de ruta', () => {
  it('marca archivos sensibles y ocultos', () => {
    expect(isSensitivePath('/proj/.env')).toBe(true);
    expect(isSensitivePath('/proj/.env.local')).toBe(true);
    expect(isSensitivePath('/home/u/.ssh/id_ed25519')).toBe(true);
    expect(isSensitivePath('/proj/keys/server.pem')).toBe(true);
    expect(isSensitivePath('/proj/src/app.ts')).toBe(false);
  });
});
