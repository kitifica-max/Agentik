import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/ipc-channels.js';

const boolean = z.boolean();
const delta = z.object({ dx: z.number().finite(), dy: z.number().finite() });
const chatMsg = z.string().min(1).max(4000);
const memId = z.number().int().positive();

export interface IpcHandlers {
  getStatus: () => unknown;
  setEnabled: (on: boolean) => unknown;
  togglePause: () => unknown;
  toggleBubble: () => void;
  moveBy: (dx: number, dy: number) => void;
  dragEnd: () => void;
  quit: () => void;
  chatSend: (msg: string) => Promise<unknown>;
  memoryList: () => unknown;
  memoryApprove: (id: number) => unknown;
  memoryReject: (id: number) => unknown;
  memoryDelete: (id: number) => unknown;
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

  ipcMain.handle(IPC.chatSend, (_e, raw: unknown) => {
    const parsed = chatMsg.safeParse(raw);
    if (!parsed.success) return { error: 'Mensaje inválido' };
    return h.chatSend(parsed.data);
  });
  ipcMain.handle(IPC.memoryList, () => h.memoryList());
  ipcMain.handle(IPC.memoryApprove, (_e, raw: unknown) => {
    const parsed = memId.safeParse(raw);
    if (!parsed.success) return false;
    return h.memoryApprove(parsed.data);
  });
  ipcMain.handle(IPC.memoryReject, (_e, raw: unknown) => {
    const parsed = memId.safeParse(raw);
    if (!parsed.success) return false;
    return h.memoryReject(parsed.data);
  });
  ipcMain.handle(IPC.memoryDelete, (_e, raw: unknown) => {
    const parsed = memId.safeParse(raw);
    if (!parsed.success) return false;
    return h.memoryDelete(parsed.data);
  });
}
