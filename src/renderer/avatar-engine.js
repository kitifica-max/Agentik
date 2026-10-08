/**
 * AgentikAvatar — motor de vida del avatar (un solo archivo, sin dependencias).
 *
 * Anima SOLO al personaje (cabeza, torso, cejas, ojos, boca). El círculo es un contenedor
 * estático: el personaje se recorta con un clipPath circular y nunca lo mueve.
 *
 * ── Uso mínimo ────────────────────────────────────────────────────────────────────────
 *   <script src="avatar-engine.js"></script>
 *   const avatar = AgentikAvatar.mount(document.querySelector('svg.body'));
 *   avatar.setAvatarState('thinking');           // idle | listening | thinking | speaking | empathy |
 *                                                //  confusion | success | calling (salta hasta que lo atiendas) | sleeping
 *   await avatar.triggerGesture('nod');          // nod, tilt, frown, baton, wink, shrug...
 *   const stop = avatar.startAudioSync(audioEl); // boca + gestos de énfasis según el audio
 *
 *   // También hay atajos globales sobre la última instancia montada:
 *   AgentikAvatar.setAvatarState('success'); AgentikAvatar.triggerGesture('baton');
 *
 * ── DOM requerido (atributos data-av dentro del elemento raíz, SVG con viewBox 0 0 163 163) ──
 *   torso   <g>        capa del torso (se estira en Y al respirar, anclado abajo)
 *   head    <g>        capa de la cabeza + cara (rota/se mueve sobre el cuello)
 *   browL, browR  <path>     cejas (se transforman con translate/rotate)
 *   lidL, lidR    <path>     párpados superiores (arco que se abre/cierra)
 *   pupilL, pupilR <ellipse> pupilas (saccades en cx/cy, parpadeo en ry)
 *   mouth   <path>     boca (sonrisa + apertura + asimetría)
 *   neckClip <path> (opcional) hueco con forma de mandíbula dentro de un <clipPath> que recorta el
 *           torso: recibe la misma transformación que la cabeza, así las líneas del cuello nunca
 *           se asoman dentro de la cara al cabecear ni se desprenden al subir.
 *   Todo se escribe con setAttribute (transform, d, cx, cy, ry): compatible con CSP estricta.
 *
 * ── Cómo funciona ───────────────────────────────────────────────────────────────────────
 *   1. Máquina de estados: cada estado define una POSE objetivo (sonrisa, cejas, párpados,
 *      inclinación...) y su "personalidad" (cada cuánto parpadea, cuánto mira alrededor,
 *      qué gestos aleatorios hace). Al cambiar de estado la pose se suaviza (sin saltos).
 *   2. Bucle de vida (requestAnimationFrame): independiente del estado calcula respiración
 *      (senoidal), parpadeo (temporizador aleatorio), saccades (miradas erráticas) y un
 *      balanceo muy leve de cabeza, para que nunca esté congelado.
 *   3. Gestos: pistas de keyframes aditivas (nod, tilt, frown, baton...). Se pueden
 *      superponer; cada uno devuelve una Promise que se resuelve al terminar.
 *   4. Audio: un AnalyserNode mide el volumen → abre la boca, activa 'speaking' y dispara
 *      gestos de batuta en los picos de énfasis.
 *   Siempre sonríe: todos los estados despiertos mantienen sonrisa > 0 (incluso el ceño
 *   fruncido solo la atenúa).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentikAvatar = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ═══ Utilidades ═══════════════════════════════════════════════════════════════════════
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t); // smoothstep: arranque y frenado suaves
  const f = (v) => String(Math.round(v * 100) / 100 || 0); // 2 decimales, sin "-0"
  // Ruido pseudo-aleatorio suave en [-1, 1]: suma de senos con frecuencias inconmensurables.
  const noise = (t, seed) =>
    Math.sin(t + seed) * 0.5 + Math.sin(t * 2.3 + seed * 1.7) * 0.3 + Math.sin(t * 4.1 + seed * 2.9) * 0.2;

  // ═══ Geometría (unidades del viewBox 163×163; sobrescribible con options.geometry) ═════
  const GEO = {
    headPivot: { x: 81.5, y: 104 }, // el cuello: la cabeza rota/cabecea alrededor de este punto
    torsoBase: 139, // el torso se estira hacia arriba desde su borde inferior
    eyeL: { x: 69.9, y: 67.8 },
    eyeR: { x: 97.4, y: 68.0 },
    browL: { x: 68.5, y: 57.0 },
    browR: { x: 96.5, y: 57.0 },
    mouth: { x: 85.2, y: 87.4 },
    eyeHalfW: 5, // mitad del ancho del párpado
  };

  // ═══ Estados ═══════════════════════════════════════════════════════════════════════════
  // pose: valores objetivo (lo no indicado toma el valor neutro de NEUTRAL).
  // blink: [min,max] ms entre parpadeos · blinkMs: duración del cierre.
  // saccade: cada cuánto cambia la mirada, amplitud (ax, ay) y sesgo (bx, by) en [-1,1].
  // breath: periodo (ms) y amplitud relativa. gestures: cada cuánto y con qué pesos elige.
  const NEUTRAL = {
    headRot: 0, headX: 0, headY: 0, // cabeza (grados / unidades)
    torsoY: 0, torsoSY: 0, // torso: desplazamiento / estiramiento relativo
    browY: 0, browInner: 0, browAsym: 0, // cejas: altura, extremos internos arriba, asimetría
    lid: 1, closeL: 0, closeR: 0, happy: 0, // párpados: apertura base, cierre extra, ojos felices (^ ^)
    gazeX: 0, gazeY: 0, // mirada extra (gestos)
    smile: 0.5, smileAsym: 0, // sonrisa y sonrisa ladeada
    mouthOpen: 0, mouthW: 1, // apertura y ancho de la boca
  };

  const STATES = {
    idle: {
      pose: { smile: 0.9, browY: -0.4 },
      blink: [3000, 5000], blinkMs: 160,
      saccade: { every: [700, 2200], ax: 0.55, ay: 0.35, bx: 0, by: 0 },
      breath: { period: 3800, amp: 1 },
      gestures: { every: [4500, 9000], pool: { tilt: 2, nod: 1, brow_raise: 2, look_around: 1.5, smile_pop: 2, wink: 0.7, shrug: 0.7, nod_double: 0.5 } },
    },
    listening: {
      pose: { smile: 0.8, browY: -1.2, lid: 1.12, headRot: 3, headY: 0.4 },
      blink: [3000, 5000], blinkMs: 170,
      saccade: { every: [1200, 2800], ax: 0.25, ay: 0.15, bx: 0, by: 0.05 },
      breath: { period: 3400, amp: 1 },
      gestures: { every: [2500, 5000], pool: { nod: 3, nod_double: 1, tilt: 2, brow_raise: 1, smile_pop: 0.5 } },
      enter: 'nod',
    },
    thinking: {
      pose: { smile: 0.45, smileAsym: 0.5, browY: -1.1, browAsym: 0.8, headRot: -4, headX: -0.4 },
      blink: [3500, 6000], blinkMs: 170,
      saccade: { every: [500, 1600], ax: 0.35, ay: 0.25, bx: -0.65, by: -0.7 }, // mira arriba-izquierda
      breath: { period: 3200, amp: 1 },
      gestures: { every: [3000, 6000], pool: { tilt: 2, look_around: 2, brow_raise: 1, frown: 0.8, shrug: 0.6 } },
    },
    speaking: {
      pose: { smile: 0.8, browY: -0.6 },
      blink: [1800, 3200], blinkMs: 140, // parpadea más seguido al hablar
      saccade: { every: [900, 2400], ax: 0.3, ay: 0.2, bx: 0, by: 0 },
      breath: { period: 2900, amp: 1.2 },
      gestures: { every: [1200, 3000], pool: { baton: 4, nod: 1, brow_raise: 1.5, tilt: 1, smile_pop: 0.7 } },
    },
    empathy: {
      pose: { smile: 0.4, browY: -0.5, browInner: 1.1, lid: 0.9, headRot: 4, headY: 0.7 },
      blink: [3500, 5500], blinkMs: 260, // parpadeos lentos y suaves
      saccade: { every: [1500, 3200], ax: 0.2, ay: 0.12, bx: 0, by: 0.15 },
      breath: { period: 4400, amp: 0.9 },
      gestures: { every: [3500, 7000], pool: { nod: 2.5, tilt: 2, brow_raise: 0.5 } },
      enter: 'tilt',
    },
    confusion: {
      pose: { smile: 0.35, smileAsym: -0.7, browY: -0.9, browAsym: 1.4, browInner: 0.3, headRot: -5, lid: 1.05 },
      blink: [2200, 4000], blinkMs: 150,
      saccade: { every: [350, 1000], ax: 0.9, ay: 0.4, bx: 0, by: -0.1 }, // mirada inquieta
      breath: { period: 3000, amp: 1.1 },
      gestures: { every: [2500, 5000], pool: { shake: 2, tilt: 2, shrug: 2, frown: 1.2, look_around: 1 } },
      enter: 'shake',
    },
    success: {
      pose: { smile: 1.3, happy: 0.9, browY: -1.5, mouthOpen: 0.5, headY: -0.8, mouthW: 1.1 },
      blink: [3000, 5000], blinkMs: 150,
      saccade: { every: [900, 2200], ax: 0.4, ay: 0.3, bx: 0, by: -0.1 },
      breath: { period: 2400, amp: 1.4 },
      gestures: { every: [2000, 4000], pool: { bounce: 2, smile_pop: 2, nod: 1, wink: 0.8 } },
      enter: 'bounce',
    },
    // Estado extra (respuesta pendiente): ilusionado, mira al frente y SALTA en bucle hasta que lo atiendas.
    calling: {
      pose: { smile: 1.2, happy: 0.55, browY: -1.6, lid: 1.15, mouthOpen: 0.3, headY: -0.5, mouthW: 1.1 },
      blink: [2500, 4000], blinkMs: 150,
      saccade: { every: [900, 1800], ax: 0.2, ay: 0.15, bx: 0, by: -0.05 },
      breath: { period: 2000, amp: 1.4 },
      gestures: { every: [1000, 1400], pool: { jump: 1 } },
      enter: 'jump',
    },
    // Estado extra (pausa del observador): ojos cerrados, respiración lenta, sin gestos.
    sleeping: {
      pose: { smile: 0.15, lid: 0, browY: 0.8, browInner: 0.4, headRot: 5, headY: 2.2, mouthW: 0.9 },
      blink: null, saccade: null, gestures: null,
      breath: { period: 5200, amp: 1.3 },
      k: 3,
    },
  };

  // ═══ Gestos (cinésica) ═════════════════════════════════════════════════════════════════
  // dur en ms. tracks: { parámetro: [[t 0..1, valor], ...] } — se SUMAN a la pose, con
  // interpolación suave entre keyframes. Valores en unidades del viewBox (≈0.74 px) o grados.
  const hold = (v, a, b) => [[0, 0], [a, v], [b, v], [1, 0]]; // sube a v, mantiene, regresa
  const GESTURES = {
    // Asentir
    nod: { dur: 750, tracks: { headY: [[0, 0], [0.28, 3.2], [0.6, -0.6], [1, 0]], headRot: [[0, 0], [0.28, -1.2], [1, 0]], browY: [[0, 0], [0.3, 0.6], [1, 0]] } },
    nod_double: { dur: 1250, tracks: { headY: [[0, 0], [0.15, 2.6], [0.3, -0.2], [0.5, 2.8], [0.7, -0.4], [1, 0]], browY: hold(0.5, 0.2, 0.55) } },
    // Negar / desconcierto
    shake: { dur: 1000, tracks: { headRot: [[0, 0], [0.18, 6], [0.42, -6], [0.66, 4.5], [0.85, -2], [1, 0]], headX: [[0, 0], [0.18, 0.8], [0.42, -0.8], [0.66, 0.6], [1, 0]], browInner: hold(0.5, 0.3, 0.8) } },
    // Ladear la cabeza (curiosidad)
    tilt: { dur: 2000, tracks: { headRot: hold(7, 0.22, 0.78), headY: hold(0.6, 0.22, 0.78), browAsym: hold(0.9, 0.3, 0.75), smile: hold(0.12, 0.3, 0.75) } },
    // Fruncir el ceño (atenúa la sonrisa, no la quita)
    frown: { dur: 1300, tracks: { browY: hold(1.1, 0.2, 0.8), browInner: hold(-1.7, 0.2, 0.8), closeL: hold(0.18, 0.2, 0.8), closeR: hold(0.18, 0.2, 0.8), smile: hold(-0.22, 0.2, 0.8) } },
    brow_raise: { dur: 1000, tracks: { browY: hold(-2.6, 0.18, 0.65), closeL: hold(-0.2, 0.18, 0.65), closeR: hold(-0.2, 0.18, 0.65), headY: [[0, 0], [0.2, -0.5], [1, 0]] } },
    // Gesto de batuta: un golpe corto de cabeza y ceja que marca un énfasis
    baton: { dur: 360, tracks: { headY: [[0, 0], [0.3, 1.4], [1, 0]], headRot: [[0, 0], [0.4, 1.8], [1, 0]], browY: [[0, 0], [0.25, -1.5], [1, 0]], torsoSY: [[0, 0], [0.3, 0.006], [1, 0]] } },
    // Encogerse de hombros
    shrug: { dur: 1400, tracks: { torsoY: hold(-2.2, 0.25, 0.7), headY: hold(-0.5, 0.25, 0.7), headRot: hold(3, 0.25, 0.7), browInner: hold(1.2, 0.25, 0.7), browY: hold(-1, 0.25, 0.7), smile: hold(-0.15, 0.25, 0.7) } },
    // Guiño (con mirror=true guiña el otro ojo)
    wink: { dur: 800, tracks: { closeR: [[0, 0], [0.14, 1], [0.5, 1], [0.8, 0], [1, 0]], smile: hold(0.4, 0.2, 0.7), headRot: hold(3, 0.2, 0.7), browY: hold(-0.6, 0.2, 0.7) } },
    smile_pop: { dur: 1100, tracks: { smile: [[0, 0], [0.25, 0.5], [0.75, 0.35], [1, 0]], mouthW: [[0, 0], [0.25, 0.2], [0.75, 0.12], [1, 0]], happy: [[0, 0], [0.25, 0.55], [0.75, 0.35], [1, 0]], browY: [[0, 0], [0.3, -0.9], [1, 0]], headY: [[0, 0], [0.25, -0.9], [1, 0]] } },
    look_around: { dur: 2400, tracks: { gazeX: [[0, 0], [0.15, -1], [0.4, -1], [0.56, 1], [0.8, 1], [1, 0]], gazeY: [[0, 0], [0.3, -0.2], [0.7, 0.1], [1, 0]], headRot: [[0, 0], [0.18, -2.5], [0.4, -2.5], [0.58, 2.5], [0.82, 2.5], [1, 0]] } },
    // Salto: sube con la cabeza llevando la delantera, cae con un pequeño rebote y se estira/aplasta al saltar
    jump: { dur: 800, tracks: { headY: [[0, 0], [0.15, 1.5], [0.38, -5], [0.58, 0.8], [0.74, -1.5], [1, 0]], torsoY: [[0, 0], [0.15, 1], [0.38, -3.5], [0.58, 0.6], [0.74, -1], [1, 0]], torsoSY: [[0, 0], [0.15, -0.025], [0.38, 0.03], [0.58, -0.015], [1, 0]], browY: hold(-1.5, 0.3, 0.8), smile: hold(0.3, 0.3, 0.8), happy: hold(0.35, 0.3, 0.8), mouthOpen: hold(0.3, 0.3, 0.8) } },
    bounce: { dur: 1000, tracks: { headY: [[0, 0], [0.18, -2.8], [0.36, 0.6], [0.54, -1.6], [0.72, 0], [1, 0]], torsoY: [[0, 0], [0.18, -1.6], [0.36, 0.3], [0.54, -0.8], [1, 0]], browY: hold(-1, 0.2, 0.8) } },
    surprise: { dur: 1200, tracks: { browY: [[0, 0], [0.12, -3.4], [0.7, -3.1], [1, 0]], closeL: [[0, 0], [0.12, -0.3], [0.7, -0.3], [1, 0]], closeR: [[0, 0], [0.12, -0.3], [0.7, -0.3], [1, 0]], mouthOpen: [[0, 0], [0.12, 0.5], [0.7, 0.4], [1, 0]], headY: [[0, 0], [0.12, -1.2], [0.7, -1], [1, 0]], torsoSY: [[0, 0], [0.12, 0.01], [1, 0]] } },
  };

  // Al espejar un gesto se invierte el lado: estos parámetros cambian de signo y L/R se intercambian.
  const MIRROR = ['headRot', 'headX', 'gazeX', 'browAsym', 'smileAsym'];
  const PART_NAMES = ['head', 'torso', 'browL', 'browR', 'lidL', 'lidR', 'pupilL', 'pupilR', 'mouth'];
  const VISIBLE_MIN_SMILE = 0.05; // sonrisa mínima en estados despiertos

  function evalTrack(track, t) {
    if (t <= track[0][0]) return track[0][1];
    for (let i = 1; i < track.length; i++) {
      if (t <= track[i][0]) {
        const a = track[i - 1];
        const b = track[i];
        return lerp(a[1], b[1], smooth((t - a[0]) / (b[0] - a[0] || 1)));
      }
    }
    return track[track.length - 1][1];
  }

  // ═══ Motor ═════════════════════════════════════════════════════════════════════════════
  class AvatarEngine {
    /**
     * @param parts   elementos del avatar (ver "DOM requerido"); basta que tengan setAttribute.
     * @param options { geometry, motionScale, gestureGain, random, raf, caf, simulateSpeech, autoStart, onStateChange }
     */
    constructor(parts, options) {
      for (const n of PART_NAMES) if (!parts[n]) throw new Error(`AgentikAvatar: falta la parte "${n}"`);
      const o = options || {};
      this.parts = parts; // PART_NAMES obligatorias + neckClip opcional
      this.geo = Object.assign({}, GEO, o.geometry);
      this.rand = o.random || Math.random;
      this.raf = o.raf || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : null);
      this.caf = o.caf || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame.bind(globalThis) : null);
      this.simulateSpeech = o.simulateSpeech !== false; // mueve la boca en 'speaking' aunque no haya audio
      this.onStateChange = o.onStateChange || null;
      // Respeta "reducir movimiento": menos amplitud y sin gestos aleatorios.
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.motionScale = o.motionScale != null ? o.motionScale : reduced ? 0.35 : 1;
      this.randomGestures = this.motionScale >= 0.5;
      // Los gestos se dibujan en un avatar de ~120 px: la ganancia los hace legibles (1 = valores de GESTURES).
      this.gain = o.gestureGain != null ? o.gestureGain : 1.5;

      this.gestures = Object.assign({}, GESTURES);
      this.clock = 0; // ms internos (avanzan con update)
      this.state = 'idle';
      this.pose = Object.assign({}, NEUTRAL, STATES.idle.pose); // pose suavizada actual
      this.out = Object.assign({}, this.pose); // pose final (con procedurales y gestos)
      this.breathPhase = 0;
      this.blink = { start: -1e9, dur: 160, next: 1500 + this.rand() * 1500, queued: -1 };
      this.gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 600 };
      this.active = []; // gestos en curso
      this.nextGesture = 3000;
      this.lastGesture = '';
      this.manualLevel = 0; // setMouthLevel
      this.speakOpen = 0; // apertura por audio / simulación
      this.audio = null;
      this.stats = { blinkTimes: [], gestures: [] }; // diagnóstico y pruebas
      this.attrCache = new WeakMap();
      this.running = false;
      this.lastTs = null;
      this.rafId = 0;
      this.tick = this.tick.bind(this);
      this.update(0);
      this.render();
      if (o.autoStart !== false) this.start();
    }

    // ── Control del bucle ──────────────────────────────────────────────────────────────
    start() {
      if (this.running || !this.raf) return this;
      this.running = true;
      this.lastTs = null;
      this.rafId = this.raf(this.tick);
      return this;
    }

    stop() {
      this.running = false;
      if (this.caf && this.rafId) this.caf(this.rafId);
      return this;
    }

    destroy() {
      this.stop();
      this.stopAudioSync();
    }

    tick(ts) {
      if (!this.running) return;
      const dt = this.lastTs == null ? 16.7 : clamp(ts - this.lastTs, 0, 50); // tope: tras una pausa no salta
      this.lastTs = ts;
      this.update(dt);
      this.render();
      this.rafId = this.raf(this.tick);
    }

    // ── API pública ────────────────────────────────────────────────────────────────────
    /** Cambia el estado del avatar con transición suave. Devuelve el estado anterior. */
    setAvatarState(state, internal) {
      if (!STATES[state]) throw new RangeError(`Estado "${state}" no existe. Válidos: ${Object.keys(STATES).join(', ')}`);
      const prev = this.state;
      if (!internal && this.audio) this.audio.autoSpeaking = false; // el usuario manda sobre el audio
      if (state === prev) return prev;
      this.state = state;
      const def = STATES[state];
      this.nextGesture = this.clock + this.range(def.gestures ? def.gestures.every : [4000, 8000]) * 0.5;
      this.gaze.next = this.clock; // mira de inmediato según el nuevo sesgo
      if (def.blink && !this.isBlinking()) this.blink.next = Math.min(this.blink.next, this.clock + this.range(def.blink));
      if (def.enter && this.motionScale >= 0.5) this.triggerGesture(def.enter, { intensity: 0.85, mirror: this.rand() < 0.5 });
      if (this.onStateChange) this.onStateChange(state, prev);
      return prev;
    }

    getAvatarState() {
      return this.state;
    }

    /**
     * Dispara un gesto. Devuelve una Promise que se resuelve cuando termina (varios gestos
     * pueden superponerse). opts: { intensity = 1, speed = 1, mirror = false }.
     */
    async triggerGesture(name, opts) {
      const def = this.gestures[name];
      if (!def) throw new RangeError(`Gesto "${name}" no existe. Válidos: ${Object.keys(this.gestures).join(', ')}`);
      if (typeof def === 'function') return def.call(this, this, opts || {}); // gesto personalizado (async)
      return this.play(def, opts, name);
    }

    /** Registra un gesto propio: objeto { dur, tracks } o función async (engine, opts). */
    registerGesture(name, def) {
      this.gestures[name] = def;
      return this;
    }

    /** Reproduce una definición { dur, tracks } directamente. */
    play(def, opts, name) {
      const o = opts || {};
      return new Promise((resolve) => {
        this.active.push({
          def,
          start: this.clock,
          dur: def.dur / (o.speed || 1),
          k: (o.intensity == null ? 1 : o.intensity) * this.motionScale * this.gain,
          mirror: !!o.mirror,
          resolve,
        });
        this.stats.gestures.push({ name: name || 'custom', at: this.clock });
      });
    }

    /** Énfasis rápido (gesto de batuta) con fuerza 0..1.5; útil al resaltar una palabra. */
    emphasize(strength) {
      return this.triggerGesture('baton', { intensity: clamp(strength == null ? 1 : strength, 0.3, 1.5), mirror: this.rand() < 0.5 });
    }

    /** Apertura manual de la boca (0..1), p. ej. desde eventos de un motor TTS sin nodo de audio. */
    setMouthLevel(level) {
      this.manualLevel = clamp(level, 0, 1);
    }

    /**
     * Sincroniza boca y gestos con una fuente de audio.
     * source: HTMLMediaElement | MediaStream | AudioNode.
     * opts: { audioContext, autoState = true (activa 'speaking' al detectar voz),
     *         emphasis = true (batuta en los picos), monitor = true (los <audio> siguen sonando) }
     * Devuelve una función stop().
     */
    startAudioSync(source, opts) {
      const o = opts || {};
      this.stopAudioSync();
      const Ctx = o.audioContext ? null : typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
      const ctx = o.audioContext || (Ctx ? new Ctx() : null);
      if (!ctx) throw new Error('AgentikAvatar: este entorno no tiene Web Audio');
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      let node;
      if (typeof HTMLMediaElement !== 'undefined' && source instanceof HTMLMediaElement) {
        // createMediaElementSource solo puede llamarse una vez por elemento: se reutiliza.
        AvatarEngine.mediaNodes = AvatarEngine.mediaNodes || new WeakMap();
        node = AvatarEngine.mediaNodes.get(source);
        if (!node) {
          node = ctx.createMediaElementSource(source);
          AvatarEngine.mediaNodes.set(source, node);
        }
        node.connect(analyser);
        if (o.monitor !== false) node.connect(ctx.destination); // que el audio se siga escuchando
      } else if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
        node = ctx.createMediaStreamSource(source);
        node.connect(analyser); // sin salida a destino: evita eco
      } else if (source && typeof source.connect === 'function') {
        node = source; // AudioNode existente: solo se deriva una copia hacia el analizador
        node.connect(analyser);
      } else {
        throw new TypeError('startAudioSync: usa un HTMLMediaElement, MediaStream o AudioNode');
      }

      this.audio = {
        ctx, node, analyser, buf: new Float32Array(analyser.fftSize),
        peak: 0.05, avg: 0, level: 0, voiceMs: 0, quietMs: 0, lastBaton: -1e9,
        autoState: o.autoState !== false, emphasis: o.emphasis !== false,
        autoSpeaking: false, prevState: this.state, ownsCtx: !o.audioContext,
      };
      return () => this.stopAudioSync();
    }

    stopAudioSync() {
      const a = this.audio;
      if (!a) return;
      this.audio = null;
      try { a.node.disconnect(a.analyser); } catch (e) { /* ya desconectado */ }
      if (a.autoSpeaking && this.state === 'speaking') this.setAvatarState(a.prevState === 'speaking' ? 'idle' : a.prevState, true);
    }

    // ── Bucle de vida ──────────────────────────────────────────────────────────────────
    range(r) {
      return r[0] + this.rand() * (r[1] - r[0]);
    }

    isBlinking() {
      return this.clock - this.blink.start < this.blink.dur;
    }

    /** Avanza la simulación dt ms. Separado de render() para poder probarlo sin DOM. */
    update(dt) {
      const s = dt / 1000;
      this.clock += dt;
      const def = STATES[this.state];
      const ms = this.motionScale;

      // 1) Pose objetivo del estado, suavizada (los cambios de estado no dan saltos)
      const target = Object.assign({}, NEUTRAL, def.pose);
      const k = 1 - Math.exp(-(def.k || 7) * s);
      for (const key in this.pose) this.pose[key] += (target[key] - this.pose[key]) * k;

      // 2) Respiración: fase acumulada (sin saltos al cambiar de periodo) → onda senoidal
      this.breathPhase += (s * 2 * Math.PI * 1000) / def.breath.period;
      const breath = Math.sin(this.breathPhase) * def.breath.amp * ms;

      // 3) Parpadeo: temporizador aleatorio propio; 12 % de las veces es doble
      const b = this.blink;
      if (def.blink && this.clock >= b.next) {
        b.start = this.clock;
        b.dur = def.blinkMs;
        this.stats.blinkTimes.push(this.clock);
        if (this.rand() < 0.12) b.queued = this.clock + def.blinkMs + 70;
        b.next = this.clock + this.range(def.blink);
      }
      if (b.queued > 0 && this.clock >= b.queued) {
        b.start = this.clock;
        b.queued = -1;
      }
      let blinkEnv = 0;
      const bt = (this.clock - b.start) / b.dur;
      if (bt >= 0 && bt < 1) blinkEnv = bt < 0.4 ? smooth(bt / 0.4) : smooth(1 - (bt - 0.4) / 0.6);

      // 4) Saccades: saltos rápidos y erráticos de la mirada alrededor del sesgo del estado
      const g = this.gaze;
      if (def.saccade && this.clock >= g.next) {
        const sc = def.saccade;
        const far = this.rand() < 0.15 ? 1.8 : 1; // de vez en cuando mira más lejos
        g.tx = clamp(sc.bx + (this.rand() * 2 - 1) * sc.ax * far, -1.2, 1.2);
        g.ty = clamp(sc.by + (this.rand() * 2 - 1) * sc.ay * far, -1, 1);
        g.next = this.clock + this.range(sc.every);
      }
      if (!def.saccade) { g.tx = 0; g.ty = 0; }
      const gk = 1 - Math.exp(-26 * s); // rápido: un saccade dura ~50 ms
      g.x += (g.tx - g.x) * gk;
      g.y += (g.ty - g.y) * gk;

      // 5) Gestos: aleatorios (según el estado) + los activos se suman
      if (def.gestures && this.randomGestures && this.clock >= this.nextGesture && this.active.length === 0) {
        const name = this.pickGesture(def.gestures.pool);
        if (name) this.triggerGesture(name, { intensity: 0.85 + this.rand() * 0.3, mirror: this.rand() < 0.5 });
      }
      if (this.clock >= this.nextGesture) this.nextGesture = this.clock + this.range(def.gestures ? def.gestures.every : [4000, 8000]);
      const gest = {};
      for (let i = this.active.length - 1; i >= 0; i--) {
        const a = this.active[i];
        const t = (this.clock - a.start) / a.dur;
        if (t >= 1) {
          this.active.splice(i, 1);
          a.resolve();
          continue;
        }
        for (const p in a.def.tracks) {
          let v = evalTrack(a.def.tracks[p], t) * a.k;
          let dest = p;
          if (a.mirror) {
            if (MIRROR.indexOf(p) >= 0) v = -v;
            if (p === 'closeL') dest = 'closeR';
            else if (p === 'closeR') dest = 'closeL';
          }
          gest[dest] = (gest[dest] || 0) + v;
        }
      }
      const G = (p) => gest[p] || 0;

      // 6) Boca: audio real > nivel manual > simulación de habla en 'speaking'
      this.updateAudio(dt, s);
      let speak = 0;
      if (this.audio) speak = this.audio.level * 0.95;
      else if (this.manualLevel > 0) speak = this.manualLevel;
      else if (this.state === 'speaking' && this.simulateSpeech) {
        const tt = this.clock / 1000;
        const syl = Math.pow(Math.max(0, Math.sin(tt * 2 * Math.PI * (5.2 + noise(tt * 0.7, 1) * 0.8))), 1.2);
        const gate = smooth(clamp(0.55 + noise(tt * 0.9, 3) * 0.9, 0, 1)); // pausas entre palabras
        speak = syl * gate * (0.45 + 0.35 * (0.5 + 0.5 * noise(tt * 1.3, 5)));
      }
      this.speakOpen += (speak - this.speakOpen) * (1 - Math.exp(-(speak > this.speakOpen ? 40 : 14) * s));

      // 7) Composición final: pose + procedurales + gestos
      const tt = this.clock / 1000;
      const p = this.pose;
      const o = this.out;
      const sleeping = this.state === 'sleeping';
      o.headRot = p.headRot + (noise(tt * 0.45, 7) * 0.7 + g.x * 0.8) * ms + G('headRot'); // balanceo leve + la cabeza acompaña a la mirada
      o.headX = p.headX + noise(tt * 0.38, 11) * 0.25 * ms + G('headX');
      o.headY = p.headY - breath * 0.55 + noise(tt * 0.5, 13) * 0.2 * ms + G('headY'); // la cabeza va sobre el pecho
      o.torsoY = p.torsoY + G('torsoY');
      o.torsoSY = p.torsoSY + breath * 0.03 + G('torsoSY'); // el torso se expande/contrae en Y
      o.browY = p.browY + G('browY');
      o.browInner = p.browInner + G('browInner');
      o.browAsym = p.browAsym + G('browAsym');
      const open = clamp(p.lid * (1 - blinkEnv), 0, 1.4);
      o.closeL = clamp(G('closeL') + p.closeL, -0.4, 1);
      o.closeR = clamp(G('closeR') + p.closeR, -0.4, 1);
      o.lidL = clamp(open * (1 - o.closeL), 0, 1.45);
      o.lidR = clamp(open * (1 - o.closeR), 0, 1.45);
      o.happy = clamp(p.happy + G('happy'), 0, 1);
      o.gazeX = clamp(g.x + G('gazeX') + p.gazeX, -1.4, 1.4);
      o.gazeY = clamp(g.y + G('gazeY') + p.gazeY, -1.2, 1.2);
      o.smile = Math.max(sleeping ? 0 : VISIBLE_MIN_SMILE, p.smile + noise(tt * 0.6, 17) * 0.05 * ms + G('smile')); // siempre sonríe
      o.smileAsym = p.smileAsym + G('smileAsym');
      o.mouthOpen = clamp(Math.max(p.mouthOpen, this.speakOpen) + G('mouthOpen'), 0, 1);
      o.mouthW = clamp(p.mouthW + G('mouthW') + (this.speakOpen > 0.05 ? noise(tt * 3, 19) * 0.08 : 0), 0.6, 1.5);
    }

    pickGesture(pool) {
      let names = Object.keys(pool).filter((n) => n !== this.lastGesture && this.gestures[n]);
      if (names.length === 0) names = Object.keys(pool).filter((n) => this.gestures[n]); // un solo gesto: se repite
      const total = names.reduce((sum, n) => sum + pool[n], 0);
      let r = this.rand() * total;
      for (const n of names) {
        r -= pool[n];
        if (r <= 0) return (this.lastGesture = n);
      }
      return (this.lastGesture = names[names.length - 1] || '');
    }

    /** Lee el volumen del audio, abre la boca, activa 'speaking' y detecta énfasis. */
    updateAudio(dt, s) {
      const a = this.audio;
      if (!a) return;
      a.analyser.getFloatTimeDomainData(a.buf);
      let sum = 0;
      for (let i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
      const rms = Math.sqrt(sum / a.buf.length);

      // Normaliza con un pico que decae lento: funciona igual con audio bajo o alto
      a.peak = Math.max(a.peak * Math.exp(-0.7 * s), rms, 0.02);
      const raw = clamp((rms / a.peak - 0.08) / 0.7, 0, 1);
      a.level += (raw - a.level) * (1 - Math.exp(-(raw > a.level ? 28 : 11) * s)); // ataque rápido, caída suave

      // Voz detectada → 'speaking'; silencio sostenido → vuelve al estado previo
      if (a.level > 0.1) { a.voiceMs += dt; a.quietMs = 0; } else { a.quietMs += dt; a.voiceMs = 0; }
      if (a.autoState) {
        if (!a.autoSpeaking && a.voiceMs > 120 && this.state !== 'speaking') {
          a.prevState = this.state;
          a.autoSpeaking = true;
          this.setAvatarState('speaking', true);
        } else if (a.autoSpeaking && a.quietMs > 700) {
          a.autoSpeaking = false;
          if (this.state === 'speaking') this.setAvatarState(a.prevState === 'speaking' ? 'idle' : a.prevState, true);
        }
      }

      // Énfasis: pico claramente por encima del promedio reciente → gesto de batuta
      a.avg += (rms - a.avg) * (1 - Math.exp(-s / 0.7));
      if (a.emphasis && rms > 0.04 && rms > a.avg * 1.8 && this.clock - a.lastBaton > 650) {
        a.lastBaton = this.clock;
        this.emphasize(rms / (a.avg || rms) / 2.2);
      }
    }

    // ── Dibujo ─────────────────────────────────────────────────────────────────────────
    setAttr(el, name, value) {
      let cache = this.attrCache.get(el);
      if (!cache) this.attrCache.set(el, (cache = {}));
      if (cache[name] === value) return; // no toca el DOM si no cambió
      cache[name] = value;
      el.setAttribute(name, value);
    }

    render() {
      const o = this.out;
      const P = this.parts;
      const G = this.geo;

      // Torso: se estira en Y desde su borde inferior (respiración)
      const sy = 1 + o.torsoSY;
      this.setAttr(P.torso, 'transform', `translate(0 ${f(o.torsoY + G.torsoBase * (1 - sy))}) scale(1 ${f(sy)})`);

      // Cabeza: rota alrededor del cuello y se desplaza
      const headT = `translate(${f(o.headX)} ${f(o.headY)}) rotate(${f(o.headRot)} ${G.headPivot.x} ${G.headPivot.y})`;
      this.setAttr(P.head, 'transform', headT);
      if (P.neckClip) this.setAttr(P.neckClip, 'transform', headT); // el hueco de la mandíbula viaja con la cabeza

      // Cejas: altura + extremos internos arriba (empatía) / abajo (ceño) + asimetría
      const bl = G.browL;
      const br = G.browR;
      this.setAttr(P.browL, 'transform', `translate(0 ${f(o.browY + o.browAsym * 0.8)}) rotate(${f(-o.browInner * 8)} ${bl.x} ${bl.y})`);
      this.setAttr(P.browR, 'transform', `translate(0 ${f(o.browY - o.browAsym * 1.6)}) rotate(${f(o.browInner * 8 - o.browAsym * 3)} ${br.x} ${br.y})`);

      // Ojos: párpado en arco + pupila que se desplaza (saccades) y se aplasta al parpadear
      this.drawEye(P.lidL, P.pupilL, G.eyeL, o.lidL, o);
      this.drawEye(P.lidR, P.pupilR, G.eyeR, o.lidR, o);

      // Boca: sonrisa (curva + esquinas arriba) + apertura (labio inferior) + asimetría
      this.drawMouth(P.mouth, o);
    }

    drawEye(lid, pupil, eye, open, o) {
      const w = this.geo.eyeHalfW;
      const h = o.happy;
      const endY = eye.y + lerp(0.6, 1.9, h);
      const ctrlY = lerp(lerp(eye.y + 0.6, eye.y - 3.4, open), eye.y - 4.2, h); // happy → arco ^
      this.setAttr(lid, 'd', `M${f(eye.x - w)} ${f(endY)}Q${f(eye.x)} ${f(ctrlY)} ${f(eye.x + w)} ${f(endY)}`);
      const gx = o.gazeX * 1.35;
      const gy = o.gazeY * 0.9;
      this.setAttr(pupil, 'cx', f(eye.x + gx));
      this.setAttr(pupil, 'cy', f(eye.y + 1.2 + gy - (1 - Math.min(open, 1)) * 0.2));
      this.setAttr(pupil, 'ry', f(Math.max(0.001, 2 * Math.min(open, 1.2) * (1 - h))));
    }

    drawMouth(mouth, o) {
      const m = this.geo.mouth;
      const s = o.smile;
      const hw = (3.2 + 1.8 * s) * o.mouthW + 0.4 * o.mouthOpen;
      const lift = 1.5 * s;
      const yl = m.y - lift * (1 + 0.6 * o.smileAsym);
      const yr = m.y - lift * (1 - 0.6 * o.smileAsym);
      const cu = m.y + 3.6 * s + 0.2; // control del labio superior
      const cl = cu + 10 * o.mouthOpen; // labio inferior: igual al superior con la boca cerrada
      let d = `M${f(m.x - hw)} ${f(yl)}Q${f(m.x)} ${f(cu)} ${f(m.x + hw)} ${f(yr)}`;
      if (o.mouthOpen > 0.02) d += `Q${f(m.x)} ${f(cl)} ${f(m.x - hw)} ${f(yl)}Z`;
      this.setAttr(mouth, 'd', d);
      this.setAttr(mouth, 'fill-opacity', f(smooth(clamp(o.mouthOpen * 3, 0, 1))));
    }
  }

  // ═══ Montaje y atajos globales ══════════════════════════════════════════════════════════
  let current = null;

  /** Busca las partes por [data-av] dentro de `rootEl` y arranca el motor. */
  function mount(rootEl, options) {
    const parts = {};
    for (const n of PART_NAMES) parts[n] = rootEl.querySelector(`[data-av="${n}"]`);
    const neckClip = rootEl.querySelector('[data-av="neckClip"]');
    if (neckClip) parts.neckClip = neckClip;
    current = new AvatarEngine(parts, options);
    return current;
  }

  const onCurrent = (method) => (...args) => {
    if (!current) throw new Error('AgentikAvatar: llama primero a mount()');
    return current[method](...args);
  };

  return {
    AvatarEngine, mount, STATES, GESTURES, NEUTRAL, PART_NAMES,
    setAvatarState: onCurrent('setAvatarState'),
    triggerGesture: onCurrent('triggerGesture'),
    startAudioSync: onCurrent('startAudioSync'),
    stopAudioSync: onCurrent('stopAudioSync'),
  };
});
