import { contextBridge, ipcRenderer } from 'electron';

const IPC = {
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
  suggestionShow: 'suggestion:show',
  suggestionAccept: 'suggestion:accept',
  suggestionDismiss: 'suggestion:dismiss',
  fileEditList: 'file-edit:list',
  fileEditApprove: 'file-edit:approve',
  fileEditApproveAll: 'file-edit:approve-all',
  fileEditReject: 'file-edit:reject',
  fileEditRejectAll: 'file-edit:reject-all',
  fileEditProposed: 'file-edit:proposed',
  auditLog: 'audit:log',
  configGetFolders: 'config:get-folders',
  configAddFolder: 'config:add-folder',
  configRemoveFolder: 'config:remove-folder',
} as const;

const INVOKE: string[] = [
  IPC.observerStatus, IPC.observerSetEnabled, IPC.observerTogglePause,
  IPC.chatSend, IPC.memoryList, IPC.memoryApprove, IPC.memoryReject, IPC.memoryDelete,
  IPC.suggestionAccept, IPC.suggestionDismiss,
  IPC.fileEditList, IPC.fileEditApprove, IPC.fileEditApproveAll, IPC.fileEditReject, IPC.fileEditRejectAll, IPC.auditLog,
  IPC.configGetFolders, IPC.configAddFolder, IPC.configRemoveFolder,
];
const SEND: string[] = [IPC.bubbleToggle, IPC.windowMoveBy, IPC.windowDragEnd, IPC.appQuit];
const LISTEN: string[] = [IPC.characterState, IPC.observerChanged, IPC.chatReply, IPC.chatThinking, IPC.memoryProposed, IPC.suggestionShow, IPC.fileEditProposed];

contextBridge.exposeInMainWorld('agetik', {
  channels: IPC,
  invoke: (channel: string, payload?: unknown) => {
    if (!INVOKE.includes(channel)) throw new Error(`IPC canal no permitido: ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  send: (channel: string, payload?: unknown) => {
    if (!SEND.includes(channel)) throw new Error(`IPC canal no permitido: ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!LISTEN.includes(channel)) throw new Error(`IPC canal no permitido: ${channel}`);
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
