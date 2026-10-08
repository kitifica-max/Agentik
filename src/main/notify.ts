// Lógica pura de los avisos (sin Electron, para poder probarla).

/** Una línea, sin saltos, recortada para que quepa en la notificación. */
export function notificationBody(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Avisa solo si están activados y NO estás mirando la burbuja (si la ves, un aviso sobra). */
export function shouldNotify(o: { enabled: boolean; bubbleVisible: boolean; bubbleFocused: boolean }): boolean {
  return o.enabled && !(o.bubbleVisible && o.bubbleFocused);
}
