import { defineConfig } from 'vite'
export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
    // The screenshot harness writes its PNGs into `shots/`, which is inside the
    // project root, so every capture was tripping the dev server's file watcher
    // and pushing a full page reload to the very page being captured. That is
    // where `npm run shots` was losing 2-6 shots a run to "page.goto ...
    // interrupted by another navigation" and "execution context was destroyed"
    // — a harness failure that looked like a renderer failure, and one that got
    // more likely as the car captures grew longer (car-idle now renders 364
    // frames before `__ready`). None of these directories is ever imported.
    watch: { ignored: ['**/shots/**', '**/.scratch/**', '**/dist/**'] },
  },
  build: {
    target: 'esnext',
    // Two entry points: the game, and the Asset Forge viewport
    // (ARCHITECTURE, "The Forge UI": "Separate Vite entry at /forge, sharing
    // the game's renderer, sky, and material"). `index.html` has to be listed
    // explicitly once `input` is set, or the game stops being built.
    rollupOptions: { input: { main: 'index.html', forge: 'forge.html' } },
  },
  // refs/ is served so the in-browser reference overlay can A/B against them
  publicDir: 'public',
})
