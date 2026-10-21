import { defineConfig } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const page = name => fileURLToPath(new URL(name, import.meta.url));

/* Files served exactly as they are. Vite only copies what is inside `public/`, and these
   sit at the repo root so that the site also works when it is deployed straight from the
   root with no build step — so the build copies them into dist/ itself. `vendor/ffmpeg`
   is the self-hosted encoder the caption generator loads at runtime; losing it means the
   MP4 export cannot start. */
const PASS_THROUGH = ['vendor', 'sample1.png'];

export default defineConfig({
  // ffmpeg.wasm spawns its own worker; Vite must not pre-bundle it
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },

  build: {
    /* Every tool is its own page. Without naming them here Vite builds only index.html,
       so each tool card on the home page 404s on the deployed site. */
    rollupOptions: {
      input: {
        index:         page('index.html'),
        captions:      page('caption-generator.html'),
        contentRemove: page('content-remove.html'),
        downloader:    page('video-downloader.html')
      }
    }
  },

  plugins: [{
    name: 'normark-copy-static',
    apply: 'build',
    closeBundle(){
      const outDir = fileURLToPath(new URL('dist/', import.meta.url));
      for (const entry of PASS_THROUGH){
        if (!existsSync(root + entry)) continue;
        cpSync(root + entry, outDir + entry, { recursive: true });
      }
    }
  }]
});
