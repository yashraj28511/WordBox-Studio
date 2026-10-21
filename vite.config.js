import { defineConfig } from 'vite';

export default defineConfig({
  // ffmpeg.wasm spawns its own worker; Vite must not pre-bundle it
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
});
