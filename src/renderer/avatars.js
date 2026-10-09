/**
 * AgentikAvatars — los personajes disponibles y cómo se dibujan (un solo archivo, sin dependencias).
 *
 * Cada avatar son DOS capas (cabeza y torso, sin el círculo) más los datos que el motor necesita:
 * dónde están los ojos, la boca y el cuello, y qué trazos originales de la cara hay que tapar
 * con "parches" del color del círculo para dibujar encima la expresión animada.
 *
 *   AgentikAvatars.build(svgEl, 'nina');                          // arma el SVG
 *   AgentikAvatar.mount(svgEl, { geometry: AgentikAvatars.get('nina').geometry });  // y lo anima
 *
 * Para agregar un avatar: separa sus capas con scripts/split-avatar.mjs, copia una entrada de AVATARS
 * y ajusta las coordenadas (unidades del viewBox 163×163).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentikAvatars = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INK = '#1e1e1e';
  const PAPER = '#e6e6e6'; // color del círculo: los parches lo igualan para "borrar" la cara original
  const NS = 'http://www.w3.org/2000/svg';

  const AVATARS = {
    nino: {
      id: 'nino',
      label: 'Niño',
      head: 'assets/nino-head.svg',
      torso: 'assets/nino-torso.svg',
      geometry: {
        headPivot: { x: 81.5, y: 104 },
        torsoBase: 139,
        eyeL: { x: 69.9, y: 67.8 },
        eyeR: { x: 97.4, y: 68.0 },
        browL: { x: 68.5, y: 57.0 },
        browR: { x: 96.5, y: 57.0 },
        mouth: { x: 85.2, y: 87.4 },
        eyeHalfW: 5,
      },
      // [x, y, ancho, alto] sobre cejas, ojos y boca originales
      patches: [[61, 55.5, 18.8, 7.5], [89.5, 55.5, 18, 7.5], [61.5, 63.5, 16, 9.5], [91, 63.5, 14, 9.5], [79.5, 83.5, 13, 9]],
      neckHole: 'M64 80H100V100.5H64Z', // hueco de la mandíbula: oculta el cuello dentro de la cara
      brows: { visible: true, L: 'M63 57.8 Q68.5 55.4 74 57.6', R: 'M90.8 57.6 Q96.3 55.4 102.2 57.8' },
    },
    nina: {
      id: 'nina',
      label: 'Niña',
      head: 'assets/nina-head.svg',
      torso: 'assets/nina-torso.svg',
      geometry: {
        headPivot: { x: 81.5, y: 101.5 },
        torsoBase: 138,
        eyeL: { x: 69.2, y: 66.8 },
        eyeR: { x: 96.5, y: 66.6 },
        browL: { x: 68.5, y: 56.5 },
        browR: { x: 96.5, y: 56.5 },
        mouth: { x: 84.2, y: 85.6 },
        eyeHalfW: 5.5,
      },
      patches: [[61.5, 63.2, 15.2, 7.4], [90.2, 63.2, 13.2, 8], [75, 83.6, 18.5, 8]],
      neckHole: 'M64 80H100V99.5H64Z',
      // Su dibujo no tiene cejas (el flequillo y los anteojos las tapan): no se dibujan; la expresión
      // va en ojos, boca y cabeza.
      brows: { visible: false, L: 'M63 56.8 Q68.5 54.6 74 56.6', R: 'M90.8 56.6 Q96.3 54.6 102.2 56.8' },
    },
  };

  const IDS = Object.keys(AVATARS);
  const get = (id) => AVATARS[id] || AVATARS.nino;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  let seq = 0; // ids únicos: hay varios SVG (personaje + miniaturas) en el mismo documento

  /** Arma el SVG de un avatar dentro de `svg` (reemplaza lo que tuviera). Solo atributos: compatible con CSP. */
  function build(svg, id) {
    const a = get(id);
    const n = ++seq;
    svg.replaceChildren();
    svg.setAttribute('viewBox', '0 0 163 163');

    const defs = el('defs', {}, svg);
    el('circle', { cx: 81.5, cy: 81.5, r: 81.5 }, el('clipPath', { id: `av-clip-${n}` }, defs));
    el('path', { 'data-av': 'neckClip', 'clip-rule': 'evenodd', d: `M-60 -60H223V223H-60Z ${a.neckHole}` }, el('clipPath', { id: `av-neck-${n}` }, defs));

    el('circle', { cx: 81.5, cy: 81.5, r: 81.5, fill: PAPER }, svg); // el círculo: solo contenedor, fijo
    const clipped = el('g', { 'clip-path': `url(#av-clip-${n})` }, svg);
    const torso = el('g', { 'data-av': 'torso' }, el('g', { 'clip-path': `url(#av-neck-${n})` }, clipped));
    el('image', { href: a.torso, width: 163, height: 163 }, torso);
    const head = el('g', { 'data-av': 'head' }, clipped);
    el('image', { href: a.head, width: 163, height: 163 }, head);

    const face = el('g', {}, head);
    for (const [x, y, w, h] of a.patches) el('rect', { x, y, width: w, height: h, fill: PAPER }, face);
    const line = { fill: 'none', stroke: INK, 'stroke-linecap': 'round' };
    for (const side of ['L', 'R']) {
      el('path', Object.assign({ 'data-av': `brow${side}`, d: a.brows[side], 'stroke-width': 1.4 }, line, a.brows.visible ? {} : { opacity: 0 }), face);
    }
    for (const side of ['L', 'R']) el('path', Object.assign({ 'data-av': `lid${side}`, d: 'M0 0', 'stroke-width': 1.5 }, line), face);
    for (const side of ['L', 'R']) el('ellipse', { 'data-av': `pupil${side}`, cx: 0, cy: 0, rx: 1.9, ry: 2, fill: INK }, face);
    el('path', { 'data-av': 'mouth', d: 'M0 0', fill: INK, stroke: INK, 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, face);
    // contorno del mismo grosor que la interfaz (2px en pantalla, sin escalar con el viewBox)
    el('circle', { cx: 81.5, cy: 81.5, r: 80.3, fill: 'none', stroke: INK, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, svg);
    return svg;
  }

  return { AVATARS, IDS, get, build, PAPER, INK };
});
