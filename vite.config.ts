import { defineConfig } from 'vite';

export default defineConfig({
  base: '/hanabi-mitai/',
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
