import { contextBridge, ipcRenderer } from 'electron';
import { IPC, INVOKE_CHANNELS, LISTEN_CHANNELS, SEND_CHANNELS } from '../shared/ipc-channels';

// Solo canales de la allowlist. Cualquier otro nombre lanza error.
function assertAllowed(list: string[], channel: string): void {
  if (!list.includes(channel)) throw new Error(`IPC canal no permitido: ${channel}`);
}

contextBridge.exposeInMainWorld('agetik', {
  channels: IPC,
  invoke: (channel: string, payload?: unknown) => {
    assertAllowed(INVOKE_CHANNELS, channel);
    return ipcRenderer.invoke(channel, payload);
  },
  send: (channel: string, payload?: unknown) => {
    assertAllowed(SEND_CHANNELS, channel);
    ipcRenderer.send(channel, payload);
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    assertAllowed(LISTEN_CHANNELS, channel);
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
