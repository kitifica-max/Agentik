import { readFileSync, writeFileSync } from 'node:fs';

// Separa assets/Agentik.svg en capas para animar el personaje sin mover el círculo (contenedor).
// Índices = orden de los <path> del SVG original. Torso: cuello, hombros, cuello de la camiseta y rayas.
const TORSO = new Set([10, 11, 12, 48, 49, 50, 51, 52, 53, 54]);

const src = readFileSync('assets/Agentik.svg', 'utf8');
const paths = [...src.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]);
if (paths.length !== 57) throw new Error(`Se esperaban 57 trazos, hay ${paths.length}`);

const layer = (keep) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 163 163">\n<style>.st1{fill:#1e1e1e}</style>\n${paths.filter((_, i) => keep(i)).join('\n')}\n</svg>\n`;

writeFileSync('assets/Agentik-head.svg', layer((i) => !TORSO.has(i)));
writeFileSync('assets/Agentik-torso.svg', layer((i) => TORSO.has(i)));
console.log(`cabeza: ${paths.length - TORSO.size} trazos · torso: ${TORSO.size} trazos`);
