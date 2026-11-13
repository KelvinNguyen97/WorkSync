/// <reference types="vite/client" />
/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import type { WorkSyncApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Exposed by `src/preload/preload.ts`. */
    worksync: WorkSyncApi;
  }
}
