// Única fuente de nombres de canal IPC. Preload expone esta lista; el renderer no inventa nombres.
export const IPC = {
  observerStatus: 'observer:status',
  observerSetEnabled: 'observer:set-enabled',
  observerTogglePause: 'observer:toggle-pause',
  bubbleToggle: 'bubble:toggle',
  windowMoveBy: 'window:move-by',
  windowDragEnd: 'window:drag-end',
  appQuit: 'app:quit',
  characterState: 'character:state',
  observerChanged: 'observer:changed',
  chatSend: 'chat:send',
  chatReply: 'chat:reply',
  chatThinking: 'chat:thinking',
  memoryList: 'memory:list',
  memoryApprove: 'memory:approve',
  memoryReject: 'memory:reject',
  memoryDelete: 'memory:delete',
  memoryProposed: 'memory:proposed',
} as const;

export const INVOKE_CHANNELS: string[] = [
  IPC.observerStatus, IPC.observerSetEnabled, IPC.observerTogglePause,
  IPC.chatSend, IPC.memoryList, IPC.memoryApprove, IPC.memoryReject, IPC.memoryDelete,
];
export const SEND_CHANNELS: string[] = [IPC.bubbleToggle, IPC.windowMoveBy, IPC.windowDragEnd, IPC.appQuit];
export const LISTEN_CHANNELS: string[] = [IPC.characterState, IPC.observerChanged, IPC.chatReply, IPC.chatThinking, IPC.memoryProposed];
