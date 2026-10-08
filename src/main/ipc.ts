import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/ipc-channels';

// Payloads validados antes de tocar nada. Un mensaje malformado se descarta.
const boolean = z.boolean();
const delta = z.object({ dx: z.number().finite(), dy: z.number().finite() });

export interface IpcHandlers {
  getStatus: () => unknown;
  setEnabled: (on: boolean) => unknown;
  togglePause: () => unknown;
  toggleBubble: () => void;
  moveBy: (dx: number, dy: number) => void;
  dragEnd: () => void;
  quit: () => void;
}

export function registerIpc(h: IpcHandlers): void {
  ipcMain.handle(IPC.observerStatus, () => h.getStatus());
  ipcMain.handle(IPC.observerSetEnabled, (_e, raw: unknown) => h.setEnabled(boolean.parse(raw)));
  ipcMain.handle(IPC.observerTogglePause, () => h.togglePause());
  ipcMain.on(IPC.bubbleToggle, () => h.toggleBubble());
  ipcMain.on(IPC.windowMoveBy, (_e, raw: unknown) => {
    const d = delta.safeParse(raw);
    if (d.success) h.moveBy(d.data.dx, d.data.dy);
  });
  ipcMain.on(IPC.windowDragEnd, () => h.dragEnd());
  ipcMain.on(IPC.appQuit, () => h.quit());
}
