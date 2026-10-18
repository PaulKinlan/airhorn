import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  plugins: [
    {
      name: 'pwa-sw-assets',
      closeBundle() {
        const distSw = path.resolve('dist/sw.js');
        const assetsDir = path.resolve('dist/assets');
        if (fs.existsSync(distSw) && fs.existsSync(assetsDir)) {
          const assets = fs.readdirSync(assetsDir).map(f => `/assets/${f}`);
          const hash = assets.map(a => a.split('-')[1]?.split('.')[0] || '').join('') || Date.now().toString(36);
          const version = `2.0.0-${hash}`;
          let content = fs.readFileSync(distSw, 'utf-8');
          content = content.replace(/__BUILD_HASH__/g, version);
          content = content.replace(/\/\* __PRECACHE_ASSETS__ \*\//g, assets.map(a => JSON.stringify(a)).join(',\n  '));
          fs.writeFileSync(distSw, content);
        }
      }
    }
  ],
});
