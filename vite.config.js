import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths: the built app (dist/) works from any directory or sub path of a web server
  base: './',
  server: { port: 8765 },
  preview: { port: 8765 },
  // The isosurface worker is an ES module (it imports the marching cubes code)
  worker: { format: 'es' },
  // three.js alone is ~600 kB minified (160 kB gzipped); one bundle is fine for this app
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 800 },
});
