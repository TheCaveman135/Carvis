import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  base: './',
  server: { host: '127.0.0.1' },
  build: {
    target: 'es2020',
    outDir: mode === 'basic' ? 'dist-basic' : 'dist',
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(process.cwd(), mode === 'basic' ? 'basic.html' : 'index.html'),
      output: { inlineDynamicImports: true },
    },
  },
}));
