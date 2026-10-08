import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AgentikAvatar = require('../src/renderer/avatar-engine.js');
const { AvatarEngine, STATES, GESTURES, PART_NAMES } = AgentikAvatar;

// RNG con semilla: las pruebas son deterministas.
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeParts(): Record<string, { a: Record<string, string>; setAttribute(k: string, v: string): void }> {
  const parts: Record<string, any> = {};
  for (const n of PART_NAMES) parts[n] = { a: {}, setAttribute(k: string, v: string) { this.a[k] = v; } };
  return parts;
}

function engine(seed = 1, extra: Record<string, unknown> = {}) {
  return new AvatarEngine(fakeParts(), { autoStart: false, random: seeded(seed), motionScale: 1, ...extra });
}

const FRAME = 1000 / 60;
function run(e: any, ms: number, each?: () => void): void {
  for (let t = 0; t < ms; t += FRAME) {
    e.update(FRAME);
    e.render();
    each?.();
  }
}

describe('máquina de estados', () => {
  it('acepta los 7 estados pedidos + sleeping y rechaza los inválidos', () => {
    const e = engine();
    for (const s of ['idle', 'listening', 'thinking', 'speaking', 'empathy', 'confusion', 'success', 'sleeping']) {
      expect(STATES[s]).toBeTruthy();
      e.setAvatarState(s);
      expect(e.getAvatarState()).toBe(s);
    }
    expect(() => e.setAvatarState('enojado')).toThrow(RangeError);
  });

  it('devuelve el estado anterior y las transiciones son suaves (sin saltos)', () => {
    const e = engine();
    run(e, 1000);
    const before = e.out.browAsym;
    expect(e.setAvatarState('confusion')).toBe('idle');
    run(e, FRAME);
    expect(Math.abs(e.out.browAsym - before)).toBeLessThan(0.5); // un frame no salta al valor final
    run(e, 3000);
    expect(e.out.browAsym).toBeGreaterThan(1); // converge al estado
  });

  it('SIEMPRE sonríe en todos los estados despiertos, incluso durante todos los gestos', () => {
    for (const s of Object.keys(STATES).filter((x) => x !== 'sleeping')) {
      const e = engine(7);
      e.setAvatarState(s);
      run(e, 2500);
      let min = Infinity;
      for (const g of Object.keys(GESTURES)) {
        e.triggerGesture(g, { mirror: true });
        run(e, 1500, () => (min = Math.min(min, e.out.smile)));
      }
      expect(min, `${s} dejó de sonreír`).toBeGreaterThan(0.04);
    }
  });
});

describe('bucle de vida', () => {
  it('respira: el torso se expande y contrae en Y de forma senoidal', () => {
    const e = engine();
    let min = 0;
    let max = 0;
    run(e, 8000, () => { min = Math.min(min, e.out.torsoSY); max = Math.max(max, e.out.torsoSY); });
    expect(max).toBeGreaterThan(0.015);
    expect(min).toBeLessThan(-0.015);
    expect(e.parts.torso.a.transform).toMatch(/^translate\(0 [-\d.]+\) scale\(1 [\d.]+\)$/);
  });

  it('parpadea cada 3-5 s en idle (dobles aparte) y más seguido al hablar', () => {
    const idle = engine(3);
    run(idle, 120_000);
    const gaps = idle.stats.blinkTimes.slice(1).map((t: number, i: number) => t - idle.stats.blinkTimes[i]);
    const normal = gaps.filter((g: number) => g > 1000); // los dobles son de ~230 ms
    expect(normal.length).toBeGreaterThan(20);
    for (const g of normal) {
      expect(g).toBeGreaterThanOrEqual(2900);
      expect(g).toBeLessThanOrEqual(5100);
    }

    const talk = engine(3);
    talk.setAvatarState('speaking');
    run(talk, 120_000);
    expect(talk.stats.blinkTimes.length).toBeGreaterThan(idle.stats.blinkTimes.length * 1.3);
  });

  it('el parpadeo cierra los párpados y aplasta la pupila, luego reabre', () => {
    const e = engine(5);
    let minOpen = 1;
    run(e, 15_000, () => { minOpen = Math.min(minOpen, e.out.lidL); });
    expect(minOpen).toBeLessThan(0.15);
    run(e, 400);
    expect(e.out.lidL).toBeGreaterThan(0.8);
  });

  it('saccades: la mirada se mueve de forma errática pero acotada', () => {
    const e = engine(9);
    const xs = new Set<string>();
    let maxAbs = 0;
    run(e, 30_000, () => {
      xs.add(e.out.gazeX.toFixed(1));
      maxAbs = Math.max(maxAbs, Math.abs(e.out.gazeX), Math.abs(e.out.gazeY));
    });
    expect(xs.size).toBeGreaterThan(8);
    expect(maxAbs).toBeLessThanOrEqual(1.4);
    expect(e.parts.pupilL.a.cx).toBeDefined();
  });

  it('thinking mira arriba-izquierda; sleeping no parpadea ni mueve los ojos y cierra los párpados', () => {
    const t = engine(2);
    t.setAvatarState('thinking');
    let sx = 0, sy = 0, n = 0;
    run(t, 20_000, () => { sx += t.out.gazeX; sy += t.out.gazeY; n++; });
    expect(sx / n).toBeLessThan(-0.2);
    expect(sy / n).toBeLessThan(-0.2);

    const s = engine(2);
    s.setAvatarState('sleeping');
    run(s, 20_000);
    expect(s.stats.blinkTimes.length).toBe(0);
    expect(s.stats.gestures.length).toBeLessThanOrEqual(1);
    expect(s.out.lidL).toBeLessThan(0.05);
  });
});

describe('gestos', () => {
  it('triggerGesture es async: se resuelve al terminar y deja la pose en su sitio', async () => {
    // Control con la misma semilla y sin gesto: aísla el efecto del gesto de la respiración y el balanceo.
    const e = engine(1);
    const control = engine(1);
    e.randomGestures = false;
    control.randomGestures = false;
    run(e, 3000);
    run(control, 3000);
    let done = false;
    const p = e.triggerGesture('nod').then(() => { done = true; });
    let peak = 0;
    const step = (ms: number) => {
      for (let t = 0; t < ms; t += FRAME) {
        e.update(FRAME); e.render(); control.update(FRAME); control.render();
        peak = Math.max(peak, e.out.headY - control.out.headY);
      }
    };
    step(300);
    expect(done).toBe(false);
    step(1700);
    await p;
    expect(done).toBe(true);
    expect(peak).toBeGreaterThan(2);
    step(100);
    expect(Math.abs(e.out.headY - control.out.headY)).toBeLessThan(0.05);
  });

  it('gesto inexistente → RangeError; mirror invierte el lado; los gestos se superponen', async () => {
    const e = engine();
    await expect(e.triggerGesture('volar')).rejects.toThrow(RangeError);

    const a = engine(4);
    const b = engine(4);
    a.randomGestures = false;
    b.randomGestures = false;
    a.triggerGesture('tilt');
    b.triggerGesture('tilt', { mirror: true });
    run(a, 700);
    run(b, 700);
    expect(Math.sign(a.out.headRot - a.pose.headRot)).toBe(-Math.sign(b.out.headRot - b.pose.headRot));

    const c = engine(4);
    c.randomGestures = false;
    c.triggerGesture('nod');
    c.triggerGesture('brow_raise');
    run(c, 250);
    expect(c.active.length).toBe(2);
  });

  it('gestos de wink usan un solo ojo y mirror cambia de ojo', () => {
    const e = engine(4);
    e.randomGestures = false;
    e.triggerGesture('wink');
    run(e, 280);
    expect(e.out.closeR).toBeGreaterThan(0.8);
    expect(e.out.closeL).toBeLessThan(0.2);
    const m = engine(4);
    m.randomGestures = false;
    m.triggerGesture('wink', { mirror: true });
    run(m, 280);
    expect(m.out.closeL).toBeGreaterThan(0.8);
  });

  it('gestos aleatorios: ocurren en idle y NO en sleeping', () => {
    const e = engine(11);
    run(e, 120_000);
    expect(e.stats.gestures.length).toBeGreaterThan(8);
    const names = new Set(e.stats.gestures.map((g: any) => g.name));
    expect(names.size).toBeGreaterThan(3);

    const s = engine(11);
    s.setAvatarState('sleeping');
    s.stats.gestures.length = 0;
    run(s, 120_000);
    expect(s.stats.gestures.length).toBe(0);
  });

  it('registerGesture acepta definiciones y funciones async propias', async () => {
    const e = engine();
    e.registerGesture('saludo', { dur: 500, tracks: { headRot: [[0, 0], [0.5, 9], [1, 0]] } });
    e.registerGesture('combo', async function (eng: any) { await eng.triggerGesture('saludo'); return 'ok'; });
    let result = '';
    const p = e.triggerGesture('combo').then((r: string) => { result = r; });
    run(e, 1200);
    await p;
    expect(result).toBe('ok');
  });

  it('prefers-reduced-motion (motionScale bajo): sin gestos aleatorios', () => {
    const e = engine(11, { motionScale: 0.3 });
    run(e, 60_000);
    expect(e.stats.gestures.length).toBe(0);
  });
});

describe('sincronía con audio', () => {
  function fakeCtx(levelRef: { v: number }) {
    return {
      state: 'running',
      destination: {},
      createAnalyser() {
        return { fftSize: 0, smoothingTimeConstant: 0, getFloatTimeDomainData(buf: Float32Array) { buf.fill(levelRef.v); } };
      },
    };
  }
  const source = () => ({ connect() {}, disconnect() {} });

  it('abre la boca con el volumen, activa speaking, lanza batuta en picos y vuelve tras el silencio', () => {
    const level = { v: 0 };
    const e = engine(6);
    e.randomGestures = false;
    run(e, 1000);
    const stop = e.startAudioSync(source(), { audioContext: fakeCtx(level) });
    level.v = 0.3;
    run(e, 600);
    let peakOpen = 0;
    level.v = 0.12;
    run(e, 1500);
    level.v = 0.5; // pico de énfasis
    run(e, 300, () => { peakOpen = Math.max(peakOpen, e.out.mouthOpen); });
    expect(e.getAvatarState()).toBe('speaking');
    expect(peakOpen).toBeGreaterThan(0.5);
    expect(e.stats.gestures.some((g: any) => g.name === 'baton')).toBe(true);
    expect(e.parts.mouth.a.d).toContain('Z'); // boca abierta dibujada

    level.v = 0;
    run(e, 2500);
    expect(e.getAvatarState()).toBe('idle');
    expect(e.out.mouthOpen).toBeLessThan(0.1);
    stop();
  });

  it('startAudioSync valida la fuente y stop() es idempotente', () => {
    const e = engine();
    expect(() => e.startAudioSync({}, { audioContext: fakeCtx({ v: 0 }) })).toThrow(TypeError);
    e.stopAudioSync();
    e.stopAudioSync();
  });

  it('setMouthLevel mueve la boca sin audio; speaking simula habla', () => {
    const e = engine(8);
    e.setMouthLevel(0.9);
    run(e, 500);
    expect(e.out.mouthOpen).toBeGreaterThan(0.6);
    e.setMouthLevel(0);
    const t = engine(8);
    t.setAvatarState('speaking');
    let max = 0;
    run(t, 5000, () => { max = Math.max(max, t.out.mouthOpen); });
    expect(max).toBeGreaterThan(0.2);
  });
});

describe('integración con el DOM del avatar', () => {
  it('escribe solo atributos SVG (compatible con CSP) en todas las partes', () => {
    const e = engine();
    run(e, 500);
    for (const n of PART_NAMES) expect(Object.keys(e.parts[n].a).length, n).toBeGreaterThan(0);
    expect(e.parts.head.a.transform).toMatch(/^translate\(.+\) rotate\(.+ 81\.5 104\)$/);
    expect(e.parts.lidL.a.d).toMatch(/^M[\d.]+ [\d.]+Q/);
    expect(e.parts.browR.a.transform).toMatch(/rotate/);
    expect(() => new AvatarEngine({}, { autoStart: false })).toThrow(/falta la parte/);
  });

  it('el hueco del cuello (neckClip, opcional) sigue exactamente la transformación de la cabeza', () => {
    const parts: any = fakeParts();
    parts.neckClip = { a: {}, setAttribute(k: string, v: string) { this.a[k] = v; } };
    const e = new AvatarEngine(parts, { autoStart: false, random: seeded(2), motionScale: 1 });
    e.randomGestures = false;
    e.triggerGesture('nod');
    for (let i = 0; i < 40; i++) {
      e.update(FRAME);
      e.render();
      expect(parts.neckClip.a.transform).toBe(parts.head.a.transform);
    }
    expect(parts.neckClip.a.transform).not.toBe('translate(0 0) rotate(0 81.5 104)');
    // sin neckClip el motor funciona igual (parte opcional)
    expect(() => engine().render()).not.toThrow();
  });
});
