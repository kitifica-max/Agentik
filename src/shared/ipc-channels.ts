// Única fuente de nombres de canal IPC. Preload expone esta lista; el renderer no inventa nombres.
export const IPC = {
  observerStatus: 'observer:status', // invoke -> ObserverStatus
  observerSetEnabled: 'observer:set-enabled', // invoke(boolean) -> ObserverStatus
  observerTogglePause: 'observer:toggle-pause', // invoke -> ObserverStatus
  bubbleToggle: 'bubble:toggle', // send
  windowMoveBy: 'window:move-by', // send {dx, dy}
  windowDragEnd: 'window:drag-end', // send
  appQuit: 'app:quit', // send
  characterState: 'character:state', // main -> character (evento)
  observerChanged: 'observer:changed', // main -> bubble (evento)
} as const;

export const INVOKE_CHANNELS: string[] = [IPC.observerStatus, IPC.observerSetEnabled, IPC.observerTogglePause];
export const SEND_CHANNELS: string[] = [IPC.bubbleToggle, IPC.windowMoveBy, IPC.windowDragEnd, IPC.appQuit];
export const LISTEN_CHANNELS: string[] = [IPC.characterState, IPC.observerChanged];
