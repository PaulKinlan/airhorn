import { defineConfig } from 'vite';
import { digestsFor, injectIntegrity } from './tools/lib/sw-integrity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function computeDistHash(distDir) {
  const hash = crypto.createHash('sha256');
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name !== 'sw.js') {
        hash.update(path.relative(distDir, fullPath));
        hash.update(fs.readFileSync(fullPath));
      }
    }
  }
  walk(distDir);
  return hash.digest('hex').slice(0, 8);
}

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  plugins: [
    {
      name: 'pwa-sw-assets',
      closeBundle() {
        const distDir = path.resolve('dist');
        const distSw = path.join(distDir, 'sw.js');
        const assetsDir = path.join(distDir, 'assets');
        if (fs.existsSync(distSw)) {
          const assets = fs.existsSync(assetsDir)
            ? fs.readdirSync(assetsDir).map(f => `/assets/${f}`)
            : [];
          const hash = computeDistHash(distDir);
          const version = `2.0.0-${hash}`;
          let content = fs.readFileSync(distSw, 'utf-8');
          content = content.replace(/__BUILD_HASH__/g, version);
          content = content.replace(/\/\* __PRECACHE_ASSETS__ \*\//g, assets.map(a => JSON.stringify(a)).join(',\n  '));
          // The build also ships the DIGESTS of its own output, so the worker can refuse a first fetch that is not the
          // bytes the builder produced (airhorn-oybq: without this the integrity record's baseline came from the very
          // fetch it vouched for, i.e. trust-on-first-use).
          content = injectIntegrity(content, digestsFor(distDir));
          fs.writeFileSync(distSw, content);
        }
      }
    }
  ],
});
