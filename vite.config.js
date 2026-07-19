import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    // pdfjs-dist + @mediapipe/tasks-vision are inherently large (PDF rendering
    // + an ML inference runtime) — this is expected, not a regression to chase.
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['src/**/*.test.js'],
  },
});
