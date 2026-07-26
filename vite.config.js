import { defineConfig } from 'vite';

/* Changes on every build and every dev-server start, and is what the analysis
 * cache keys on (src/analysisCache.js). Detection results must never outlive
 * the code that produced them: a hand-maintained version constant would have
 * to be bumped by whoever tunes a detection threshold, and forgetting is
 * silent -- the app keeps serving the old detector's answers and the change
 * appears to do nothing. This cannot be forgotten. */
const BUILD_ID = String(Date.now());

export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
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
