import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const R = createRequire(import.meta.url)('../src/renderer/richtext.js') as { parse: (t: string) => { t: string; s: string }[][] };
const flat = (t: string) => R.parse(t).map((l) => l.map((x) => (x.t === 'text' ? x.s : `<${x.t}>${x.s}</${x.t}>`)).join(''));

describe('formato de respuestas', () => {
  it('negrita y código en línea; el resto es texto literal', () => {
    expect(flat('Hola **mundo** y `ls -la` fin')).toEqual(['Hola <b>mundo</b> y <code>ls -la</code> fin']);
    expect(flat('2 * 3 = 6 y **sin cerrar')).toEqual(['2 * 3 = 6 y **sin cerrar']);
    expect(flat('****')).toEqual(['****']);
  });
  it('viñetas y títulos', () => {
    expect(flat('- uno\n* dos\n  - sub **negrita**\nnormal')).toEqual(['• uno', '• dos', '  • sub <b>negrita</b>', 'normal']);
    expect(flat('## Título con `x`')).toEqual(['<b>Título con </b><code>x</code>']);
  });
  it('nunca interpreta HTML: llega como texto', () => {
    expect(flat('<img src=x onerror=alert(1)> **<b>hola</b>**')).toEqual(['<img src=x onerror=alert(1)> <b><b>hola</b></b>']);
    const spans = R.parse('<script>alert(1)</script>')[0]!;
    expect(spans).toEqual([{ t: 'text', s: '<script>alert(1)</script>' }]);
  });
  it('conserva las líneas vacías y los saltos', () => {
    expect(flat('a\n\nb')).toEqual(['a', '', 'b']);
  });
});
