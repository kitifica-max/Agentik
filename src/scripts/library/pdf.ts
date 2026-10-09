import type { ScriptCtx } from '../types.js';

// Texto de un PDF con PDFKit, que ya viene en macOS (vía osascript/JXA). Sin instalar nada.
const JXA = `ObjC.import('Quartz');
function run(argv) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return '';
  var s = doc.string;
  return s && !s.isNil() ? ObjC.unwrap(s) : '';
}`;

export async function pdfText(ctx: ScriptCtx, file: string, maxChars = 8000): Promise<string> {
  const osa = ctx.bin('osascript');
  if (!osa) return '';
  const r = await ctx.exec(osa, ['-l', 'JavaScript', '-e', JXA, file], { timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.slice(0, maxChars) : '';
}
