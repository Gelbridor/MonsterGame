import { defineConfig } from 'vite';

// Relative base so the same build works from `npm run preview`, GitHub Pages
// (served from /<repo>/) or any static host.
export default defineConfig({
  base: './',
  server: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
