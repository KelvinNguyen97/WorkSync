import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // blob: for images pasted into notes, which the page itself makes.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

// Applied to production builds only: the dev server relies on inline scripts
// and a websocket for hot reload, which this policy would block.
const injectContentSecurityPolicy = (): Plugin => ({
  name: 'worksync:inject-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: contentSecurityPolicy,
      },
      injectTo: 'head-prepend',
    },
  ],
});

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), injectContentSecurityPolicy()],
});
