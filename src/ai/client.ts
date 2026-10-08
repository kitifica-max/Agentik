import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from '../db/db.js';
import type { Config, ChatMessage, Memory } from '../shared/types.js';
import { recentEventsSummary } from './eventSummary.js';
import { approvedMemoriesForContext } from '../memory/memory.js';
import { isSensitiveText } from '../memory/filters.js';
import { isSensitivePath } from '../observer/filters.js';

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `Eres Agetik. Operas archivos con etiquetas. El sistema las parsea y ejecuta.

ETIQUETAS (usa rutas absolutas reales del listado de abajo):
[FILE_MKDIR:/ruta/carpeta]
[FILE_MOVE:/ruta/origen:/ruta/destino]
[FILE_COPY:/ruta/origen:/ruta/destino]
[FILE_EDIT:/ruta/archivo]contenido[/FILE_EDIT]

REGLAS ABSOLUTAS:
1. SÉ DIRECTO. Cero plática. Recibe instrucción → emite etiquetas. Máximo 1 oración corta antes de las etiquetas.
2. Cuando pidan operar archivos, EMITE LAS ETIQUETAS. No expliques, no pidas permiso, no digas "no puedo". Las etiquetas SON tu acción.
3. Incluye TODAS las operaciones en una respuesta. Si creas carpetas, también mueve archivos a ellas.
4. Primero [FILE_MKDIR], luego [FILE_MOVE]/[FILE_COPY], luego [FILE_EDIT].
5. Usa las rutas REALES que ves en el listado de carpetas autorizadas.
6. NUNCA digas "no puedo", "no tengo acceso", "no ejecuto comandos". Sí puedes. Con etiquetas.
7. Español. Breve. Sin saludos, sin explicaciones, sin preguntas innecesarias.
8. [MEMORY:tipo:contenido] solo si piden recordar. Tipos: preferencia|proyecto|decisión|contexto.
9. No toques .env, SSH, credenciales, archivos ocultos. No borres archivos.

EJEMPLO — "organiza mis descargas":
Organizando:
[FILE_MKDIR:/Users/x/Downloads/Imagenes]
[FILE_MKDIR:/Users/x/Downloads/Docs]
[FILE_MOVE:/Users/x/Downloads/foto.jpg:/Users/x/Downloads/Imagenes/foto.jpg]
[FILE_MOVE:/Users/x/Downloads/informe.pdf:/Users/x/Downloads/Docs/informe.pdf]`;

function listFolder(folderPath: string, maxDepth = 2, prefix = ''): string[] {
  const lines: string[] = [];
  try {
    const entries = readdirSync(folderPath).sort();
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = join(folderPath, name);
      if (isSensitivePath(full)) continue;
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          lines.push(`${prefix}${name}/`);
          if (maxDepth > 1 && lines.length < 200) {
            lines.push(...listFolder(full, maxDepth - 1, prefix + '  '));
          }
        } else {
          lines.push(`${prefix}${name}`);
        }
      } catch { /* skip unreadable */ }
      if (lines.length >= 200) break;
    }
  } catch { /* folder unreadable */ }
  return lines;
}

function allowedFoldersListing(config: Config): string {
  if (config.allowed_folders.length === 0) return '';
  const parts: string[] = ['Contenido de carpetas autorizadas:'];
  for (const folder of config.allowed_folders) {
    const abs = resolve(folder);
    const listing = listFolder(abs);
    if (listing.length > 0) {
      parts.push(`\n📁 ${abs}`);
      parts.push(...listing);
    }
  }
  return parts.length > 1 ? parts.join('\n') : '';
}

export class AiClient {
  private anthropic: Anthropic;
  private sessionHistory: ChatMessage[] = [];

  constructor(
    private db: Db,
    private config: Config,
  ) {
    this.anthropic = new Anthropic();
  }

  clearSession(): void {
    this.sessionHistory = [];
  }

  async chat(userMessage: string): Promise<{ reply: string; proposedMemory?: { tipo: string; contenido: string } }> {
    const contextParts: string[] = [];

    const eventSummary = recentEventsSummary(this.db);
    if (eventSummary) contextParts.push(eventSummary);

    if (this.config.memory_enabled) {
      const memories = approvedMemoriesForContext(this.db, this.config.memory_max_items_per_request);
      if (memories.length > 0) {
        contextParts.push('Recuerdos del usuario:\n' + memories.map((m: Memory) => `- [${m.tipo}] ${m.contenido}`).join('\n'));
      }
    }

    const folderListing = allowedFoldersListing(this.config);
    if (folderListing) contextParts.push(folderListing);

    const system = contextParts.length > 0
      ? SYSTEM_PROMPT + '\n\n' + contextParts.join('\n\n')
      : SYSTEM_PROMPT;

    this.sessionHistory.push({ role: 'user', content: userMessage });

    const messages = this.sessionHistory.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let fullText = '';
    const MAX_CONTINUATIONS = 3;
    let currentMsgs = [...messages];

    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      const response = await this.anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: currentMsgs,
      });

      const chunk = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      fullText += chunk;

      if (response.stop_reason !== 'max_tokens') break;
      // ponytail: Haiku no soporta prefill, usar user message para continuar
      currentMsgs = [
        ...currentMsgs,
        { role: 'assistant' as const, content: chunk },
        { role: 'user' as const, content: 'Continúa exactamente donde te quedaste. Solo emite las etiquetas restantes.' },
      ];
    }

    const text = fullText;

    this.sessionHistory.push({ role: 'assistant', content: text });
    if (this.sessionHistory.length > 40) {
      this.sessionHistory = this.sessionHistory.slice(-30);
    }

    const memoryMatch = text.match(/\[MEMORY:(\w+):(.+?)\]/);
    let proposedMemory: { tipo: string; contenido: string } | undefined;
    if (memoryMatch && !isSensitiveText(memoryMatch[2])) {
      proposedMemory = { tipo: memoryMatch[1], contenido: memoryMatch[2] };
    }

    const cleanReply = text.replace(/\[MEMORY:\w+:.+?\]/g, '').trim();

    return { reply: cleanReply, proposedMemory };
  }
}
