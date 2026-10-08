/**
 * AgentikSounds — sonidos sintetizados (sin archivos de audio).
 *   AgentikSounds.playPop();            // "pop" corto al tener una respuesta pendiente
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentikSounds = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Programa un "pop" (burbuja que revienta): tono que cae rápido y se apaga. Devuelve cuándo termina (s). */
  function pop(ctx, volume = 0.5, when = ctx.currentTime) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, when);
    osc.frequency.exponentialRampToValueAtTime(150, when + 0.09);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), when + 0.006); // ataque casi instantáneo
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.15);
    return when + 0.15;
  }

  let shared = null;
  function playPop(volume) {
    try {
      const Ctx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
      if (!Ctx) return false;
      shared = shared || new Ctx();
      if (shared.state === 'suspended') shared.resume();
      pop(shared, volume);
      return true;
    } catch (e) {
      return false; // sin audio disponible: el aviso visual sigue funcionando
    }
  }

  return { pop, playPop };
});
