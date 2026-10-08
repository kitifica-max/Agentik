import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Genera el ícono de la app (macOS): build/icon.svg y build/icon.icns.
// Usa el personaje de assets/Agentik.svg con la cara sonriente del motor, sobre fondo gris.
// Requiere: rsvg-convert (brew install librsvg), sips e iconutil (vienen con macOS).
const require = createRequire(import.meta.url);
const { AvatarEngine, PART_NAMES } = require('../src/renderer/avatar-engine.js');

const BG = '#e6e6e6';
const INK = '#1e1e1e';

// 1) Cara en reposo: se calcula con el mismo motor que anima el personaje (sin parpadeo ni mirada).
const parts = {};
for (const n of PART_NAMES) parts[n] = { a: {}, setAttribute(k, v) { this.a[k] = v; } };
const engine = new AvatarEngine(parts, { autoStart: false, random: () => 0.5, motionScale: 1 });
engine.pose.smile = 1.1;
engine.update(0);
engine.render();
const a = (n) => parts[n].a;

// 2) Trazos del personaje (sin el círculo original)
const src = readFileSync('assets/Agentik.svg', 'utf8');
const paths = [...src.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]).join('\n');

const face = `
  <g fill="${BG}">
    <rect x="61" y="55.5" width="18.8" height="7.5"/><rect x="89.5" y="55.5" width="18" height="7.5"/>
    <rect x="61.5" y="63.5" width="16" height="9.5"/><rect x="91" y="63.5" width="14" height="9.5"/>
    <rect x="79.5" y="83.5" width="13" height="9"/>
  </g>
  <g fill="none" stroke="${INK}" stroke-linecap="round">
    <path stroke-width="1.4" d="M63 57.8 Q68.5 55.4 74 57.6" transform="${a('browL').transform}"/>
    <path stroke-width="1.4" d="M90.8 57.6 Q96.3 55.4 102.2 57.8" transform="${a('browR').transform}"/>
    <path stroke-width="1.5" d="${a('lidL').d}"/><path stroke-width="1.5" d="${a('lidR').d}"/>
  </g>
  <ellipse cx="${a('pupilL').cx}" cy="${a('pupilL').cy}" rx="1.9" ry="${a('pupilL').ry}" fill="${INK}"/>
  <ellipse cx="${a('pupilR').cx}" cy="${a('pupilR').cy}" rx="1.9" ry="${a('pupilR').ry}" fill="${INK}"/>
  <path d="${a('mouth').d}" fill="${INK}" fill-opacity="${a('mouth')['fill-opacity']}" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;

// 3) Ícono 1024×1024 con la retícula de macOS: cuerpo de 824 px, esquinas de 185 px y sombra suave
const S = 6.3; // escala del personaje (unidades del avatar → px)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
  <filter id="shadow" x="-15%" y="-15%" width="130%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="14"/>
    <feOffset dy="14"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <clipPath id="body"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  <style>.st1{fill:${INK}}</style>
</defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="${BG}" filter="url(#shadow)"/>
<g clip-path="url(#body)">
  <g transform="translate(4 27) scale(${S})">
${paths}
${face}
  </g>
</g>
</svg>
`;

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.svg', svg);

// 4) SVG → PNG 1024 → .iconset → .icns
const tmp = mkdtempSync(join(tmpdir(), 'agentik-icon-'));
try {
  const master = join(tmp, 'icon.png');
  execFileSync('rsvg-convert', ['-w', '1024', '-h', '1024', 'build/icon.svg', '-o', master]);
  const iconset = join(tmp, 'icon.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(size), String(size), master, '--out', join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(size * 2), String(size * 2), master, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', 'build/icon.icns']);
  writeFileSync('build/icon.png', readFileSync(master));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('build/icon.svg, build/icon.png y build/icon.icns generados');
