import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot, PlannerApi } from '@shared/contracts';

const api: PlannerApi = {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  onSnapshot: (listener) => {
    const handler = (_e: unknown, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on('snapshot', handler);
    return () => ipcRenderer.removeListener('snapshot', handler);
  },
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  pvpHistory: () => ipcRenderer.invoke('pvp:history'),
  pvpDetail: (file) => ipcRenderer.invoke('pvp:detail', file),
  pvpArena: (limit) => ipcRenderer.invoke('pvp:arena', limit),
  battleHistory: (limit) => ipcRenderer.invoke('battles:history', limit),
  testNotification: () => ipcRenderer.invoke('notify:test'),
  openDataFolder: () => ipcRenderer.invoke('shell:openDataFolder'),
};

contextBridge.exposeInMainWorld('planner', api);
