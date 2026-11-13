import { contextBridge, ipcRenderer } from 'electron';
import {
  API_METHODS,
  OPEN_EVENT,
  SOURCES_EVENT,
  type OpenTarget,
  channel,
  type WorkSyncApi,
} from '../shared/ipc';
import type { SourceFile } from '../shared/sources';

// Expose a narrow, typed API instead of ipcRenderer itself, so the renderer
// can only call the methods listed in API_METHODS.
const api = Object.fromEntries(
  API_METHODS.map((method) => [
    method,
    async (...args: unknown[]) => {
      try {
        return await ipcRenderer.invoke(channel(method), ...args);
      } catch (error) {
        // Electron prefixes errors with "Error invoking remote method ...";
        // keep only the message the main process wrote for the owner.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          message.replace(
            /^Error invoking remote method '[^']+': (Error: )?/,
            '',
          ),
        );
      }
    },
  ]),
) as unknown as WorkSyncApi;

api.onSourcesChanged = (listener) => {
  const handler = (_e: Electron.IpcRendererEvent, list: SourceFile[]) =>
    listener(list);
  ipcRenderer.on(SOURCES_EVENT, handler);
  return () => ipcRenderer.removeListener(SOURCES_EVENT, handler);
};

api.onOpen = (listener) => {
  const handler = (_e: Electron.IpcRendererEvent, target: OpenTarget) =>
    listener(target);
  ipcRenderer.on(OPEN_EVENT, handler);
  return () => ipcRenderer.removeListener(OPEN_EVENT, handler);
};

contextBridge.exposeInMainWorld('worksync', api);
