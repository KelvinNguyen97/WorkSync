import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // SQLite is built into Electron's Node.js, so it is never bundled; koffi
      // has a native binary and is copied into the app instead (forge.config).
      external: ['node:sqlite', 'koffi'],
    },
  },
});
