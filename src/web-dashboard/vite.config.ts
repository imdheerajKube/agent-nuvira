import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  publicDir: false, // Disable publicDir since outDir is 'public/'
  build: {
    outDir: 'public',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 3030,
    proxy: {
      '/api': 'http://localhost:3030',
    },
  },
});
