import { readFileSync, writeFileSync } from 'node:fs';

// Separa cada ilustración en capas (cabeza y torso, sin el círculo) para animar al personaje sin mover
// el círculo (contenedor). Los índices son el orden de los <path> del SVG original.
// Torso = cuello, hombros, cuello de la prenda y detalles de la ropa.
const AVATARS = [
  { id: 'nino', src: 'assets/Agentik.svg', paths: 57, torso: [10, 11, 12, 48, 49, 50, 51, 52, 53, 54] },
  { id: 'nina', src: 'assets/Agentik_2.svg', paths: 63, torso: [8, 9, 17, ...Array.from({ length: 19 }, (_, i) => 44 + i)] },
];

for (const a of AVATARS) {
  const src = readFileSync(a.src, 'utf8');
  const paths = [...src.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]);
  if (paths.length !== a.paths) throw new Error(`${a.src}: se esperaban ${a.paths} trazos, hay ${paths.length}`);
  const torso = new Set(a.torso);
  const layer = (keep) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 163 163">\n<style>.st1{fill:#1e1e1e}</style>\n${paths.filter((_, i) => keep(i)).join('\n')}\n</svg>\n`;
  writeFileSync(`assets/${a.id}-head.svg`, layer((i) => !torso.has(i)));
  writeFileSync(`assets/${a.id}-torso.svg`, layer((i) => torso.has(i)));
  console.log(`${a.id}: cabeza ${paths.length - torso.size} trazos · torso ${torso.size} trazos`);
}
