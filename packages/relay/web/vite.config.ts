import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Build into relay/public so the relay serves it statically.
export default defineConfig({
  build: {
    outDir: resolve(__dirname, '../public'),
    emptyOutDir: true,
  },
  server: {
    // Dev proxy: /ws → relay on 127.0.0.1:8787
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
