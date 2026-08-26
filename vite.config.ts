import { defineConfig } from 'vite'
export default defineConfig({
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'esnext' },
  // refs/ is served so the in-browser reference overlay can A/B against them
  publicDir: 'public',
})
