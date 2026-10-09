import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { parseConfig } from '../src/main/config.js';

const require = createRequire(import.meta.url);
const Avatars = require('../src/renderer/avatars.js');
const Engine = require('../src/renderer/avatar-engine.js');
const Sounds = require('../src/renderer/sounds.js');

// ── DOM mínimo para correr build() y montar el motor sin navegador
class FakeEl {
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  appendChild(c: FakeEl) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  all(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel: string): FakeEl | null {
    const m = /^\[data-av="(.+)"\]$/.exec(sel);
    return m ? this.all().find((e) => e.attrs['data-av'] === m[1]) ?? null : null;
  }
}
const g = globalThis as any;
beforeAll(() => { g.document = { createElementNS: (_: string, tag: string) => new FakeEl(tag) }; });
afterAll(() => { delete g.document; });

describe('definiciones de avatar', () => {
  it('hay niño y niña; un id desconocido cae al niño', () => {
    expect(Avatars.IDS).toEqual(['nino', 'nina']);
    expect(Avatars.get('nina').label).toBe('Niña');
    expect(Avatars.get('???').id).toBe('nino');
  });

  it.each(['nino', 'nina'])('%s: sus capas existen y su geometría cabe en el viewBox 163×163', (id) => {
    const a = Avatars.get(id);
    expect(existsSync(a.head)).toBe(true);
    expect(existsSync(a.torso)).toBe(true);
    const pts = [a.geometry.eyeL, a.geometry.eyeR, a.geometry.browL, a.geometry.browR, a.geometry.mouth, a.geometry.headPivot];
    for (const p of pts) { expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(163); expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(163); }
    expect(a.geometry.eyeL.x).toBeLessThan(a.geometry.eyeR.x);
    expect(a.geometry.eyeHalfW).toBeGreaterThan(3);
    for (const [x, y, w, h] of a.patches) { expect(x + w).toBeLessThanOrEqual(163); expect(y + h).toBeLessThanOrEqual(163); expect(w * h).toBeGreaterThan(0); }
    expect(a.neckHole).toMatch(/^M\d+ \d+H\d+V[\d.]+H\d+Z$/);
  });

  it('build() arma todas las partes que exige el motor + el hueco del cuello, y el motor monta y dibuja sobre él', () => {
    for (const id of Avatars.IDS) {
      const svg = new FakeEl('svg');
      Avatars.build(svg, id);
      for (const n of [...Engine.PART_NAMES, 'neckClip']) expect(svg.querySelector(`[data-av="${n}"]`), `${id}:${n}`).not.toBeNull();
      const engine = Engine.mount(svg, { geometry: Avatars.get(id).geometry, autoStart: false, random: () => 0.5 });
      // la primera pasada ya dibujó sonrisa, párpados y pupilas
      expect(svg.querySelector('[data-av="mouth"]')!.attrs.d).toMatch(/^M[\d.]+ [\d.]+Q/);
      expect(svg.querySelector('[data-av="lidL"]')!.attrs.d).toMatch(/^M[\d.]+ [\d.]+Q/);
      expect(Number(svg.querySelector('[data-av="pupilL"]')!.attrs.ry)).toBeGreaterThan(1);
      engine.update(16); engine.render();
    }
  });

  it('la niña no tiene cejas dibujadas (su arte no las tiene); el niño sí', () => {
    const nino = new FakeEl('svg'); Avatars.build(nino, 'nino');
    const nina = new FakeEl('svg'); Avatars.build(nina, 'nina');
    expect(nino.querySelector('[data-av="browL"]')!.attrs.opacity).toBeUndefined();
    expect(nina.querySelector('[data-av="browL"]')!.attrs.opacity).toBe('0');
  });

  it('cada build usa ids de recorte únicos (varias miniaturas en el mismo documento no se pisan)', () => {
    const a = new FakeEl('svg'); const b = new FakeEl('svg');
    Avatars.build(a, 'nino'); Avatars.build(b, 'nina');
    const ids = [...a.all(), ...b.all()].filter((e) => e.tag === 'clipPath').map((e) => e.attrs.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it('el círculo (contenedor) no lleva datos de animación: queda fijo', () => {
    const svg = new FakeEl('svg'); Avatars.build(svg, 'nina');
    const circles = svg.children.filter((e) => e.tag === 'circle');
    expect(circles).toHaveLength(2); // contenedor + aro de contorno
    for (const c of circles) expect(c.attrs['data-av']).toBeUndefined();
  });
});

describe('respuesta pendiente: salto en bucle', () => {
  function engine(seed = 1) {
    const parts: Record<string, any> = {};
    for (const n of Engine.PART_NAMES) parts[n] = { setAttribute() {} };
    let a = seed;
    const rnd = () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296; };
    return new Engine.AvatarEngine(parts, { autoStart: false, random: rnd, motionScale: 1 });
  }
  const run = (e: any, ms: number) => { for (let t = 0; t < ms; t += 16.7) { e.update(16.7); e.render(); } };

  it('calling salta una y otra vez mientras siga pendiente, y SIEMPRE sonriendo', () => {
    const e = engine();
    run(e, 3000);
    e.stats.gestures.length = 0;
    e.setAvatarState('calling');
    let minSmile = Infinity, highest = 0;
    for (let t = 0; t < 12_000; t += 16.7) { e.update(16.7); minSmile = Math.min(minSmile, e.out.smile); highest = Math.min(highest, e.out.headY); }
    const jumps = e.stats.gestures.filter((g: any) => g.name === 'jump').length;
    expect(jumps).toBeGreaterThanOrEqual(7); // ~1 salto por segundo y medio, sin parar
    expect(highest).toBeLessThan(-5); // sube de verdad
    expect(minSmile).toBeGreaterThan(0.9);
  });

  it('deja de saltar al volver a idle (se abrió el chat)', () => {
    const e = engine(3);
    e.setAvatarState('calling');
    run(e, 4000);
    e.setAvatarState('idle');
    run(e, 1500); // termina el salto en curso
    e.stats.gestures.length = 0;
    run(e, 3000);
    expect(e.stats.gestures.filter((g: any) => g.name === 'jump')).toHaveLength(0);
  });

  it('un estado con un solo gesto posible sigue sorteándolo (antes se quedaba sin opciones)', () => {
    const e = engine();
    e.setAvatarState('calling');
    run(e, 30_000);
    expect(e.stats.gestures.length).toBeGreaterThan(15);
  });

  it('respeta "reducir movimiento": sin saltos aleatorios (queda la insignia y el aviso)', () => {
    const parts: Record<string, any> = {};
    for (const n of Engine.PART_NAMES) parts[n] = { setAttribute() {} };
    const e = new Engine.AvatarEngine(parts, { autoStart: false, random: () => 0.5, motionScale: 0.3 });
    e.setAvatarState('calling');
    run(e, 10_000);
    expect(e.stats.gestures.filter((g: any) => g.name === 'jump')).toHaveLength(0);
  });
});

describe('sonido pop', () => {
  function fakeCtx() {
    const log: any = { freq: [], gain: [], started: 0, stopped: 0, connected: 0 };
    const param = (list: any[]) => ({ setValueAtTime: (v: number, t: number) => list.push(['set', v, t]), exponentialRampToValueAtTime: (v: number, t: number) => list.push(['ramp', v, t]), value: 0 });
    return {
      log, currentTime: 10, destination: {},
      createOscillator: () => ({ type: '', frequency: param(log.freq), connect() { log.connected++; }, start() { log.started++; }, stop() { log.stopped++; } }),
      createGain: () => ({ gain: param(log.gain), connect() { log.connected++; } }),
    };
  }

  it('es un tono corto que cae de agudo a grave, con ataque rápido y se apaga solo', () => {
    const ctx = fakeCtx();
    const end = Sounds.pop(ctx as any, 0.5);
    const [f0, f1] = [ctx.log.freq[0], ctx.log.freq[1]];
    expect(f0[1]).toBeGreaterThan(f1[1] * 3); // cae al menos 3x
    expect(f1[2] - f0[2]).toBeLessThan(0.15); // en menos de 150 ms
    const [g0, g1, g2] = ctx.log.gain;
    expect(g0[1]).toBeLessThan(0.01); // arranca en silencio (sin "clic")
    expect(g1[1]).toBe(0.5); // sube al volumen pedido
    expect(g1[2] - g0[2]).toBeLessThan(0.02); // ataque casi instantáneo
    expect(g2[1]).toBeLessThan(0.01); // termina en silencio
    expect(ctx.log.started).toBe(1);
    expect(ctx.log.stopped).toBe(1);
    expect(end - 10).toBeLessThan(0.3);
  });

  it('sin Web Audio no revienta (el aviso visual sigue)', () => {
    expect(Sounds.playPop()).toBe(false);
  });
});

describe('ajustes', () => {
  it('config: avatar niño y sonido activado por defecto; avatar inválido se rechaza', () => {
    const c = parseConfig({});
    expect(c.avatar).toBe('nino');
    expect(c.sounds).toBe(true);
    expect(parseConfig({ avatar: 'nina' }).avatar).toBe('nina');
    expect(() => parseConfig({ avatar: 'robot' })).toThrow();
  });
});
