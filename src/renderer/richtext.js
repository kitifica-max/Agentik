/**
 * AgentikRichText — formato mínimo y seguro para las respuestas del agente (sin DOM: se puede probar en Node).
 * Entiende **negrita**, `código`, viñetas («- », «* ») y títulos («# »). Todo lo demás es texto literal:
 * nunca se interpreta HTML, así que un modelo (o una página web) no puede inyectar nada.
 * parse(texto) → líneas; cada línea = lista de tramos { t: 'text' | 'b' | 'code', s }.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentikRichText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;

  function inline(line) {
    const out = [];
    for (const part of line.split(INLINE)) {
      if (!part) continue;
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) out.push({ t: 'b', s: part.slice(2, -2) });
      else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) out.push({ t: 'code', s: part.slice(1, -1) });
      else out.push({ t: 'text', s: part });
    }
    return out;
  }

  function parse(text) {
    return String(text).split('\n').map((raw) => {
      const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(raw);
      if (bullet) return [{ t: 'text', s: bullet[1] + '• ' }, ...inline(bullet[2])];
      const head = /^\s*#{1,6}\s+(.*)$/.exec(raw);
      if (head) return inline(head[1]).map((x) => (x.t === 'text' ? { t: 'b', s: x.s } : x));
      return inline(raw);
    });
  }

  return { parse };
});
