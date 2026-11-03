import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Files in `public/` that the app needs offline. They are not part of the bundle, so list them. */
const PUBLIC_FILES = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

/**
 * Writes `sw.js` with the list of every built file to cache. The names carry content hashes, so the
 * list is only known at build time; a cache version derived from it means a new release never
 * serves stale files.
 */
function precacheServiceWorker(): Plugin {
  return {
    name: 'accident-precache-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      // A missing file would make the browser reject the whole install, which silently breaks
      // offline for everyone. Fail the build instead.
      for (const file of PUBLIC_FILES.filter((f) => f !== '/')) {
        if (!existsSync(new URL(`./public${file}`, import.meta.url))) {
          this.error(`public${file} is listed for offline caching but does not exist`);
        }
      }
      const built = Object.keys(bundle)
        .filter((file) => !file.endsWith('.map'))
        .map((file) => `/${file}`);
      const files = [...new Set([...PUBLIC_FILES, ...built])].sort();
      const version = `accident-${createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12)}`;
      const template = readFileSync(new URL('./src/sw.template.js', import.meta.url), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template
          .replace('__VERSION__', version)
          .replace('__PRECACHE__', JSON.stringify(files, null, 2)),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precacheServiceWorker()],
  build: { target: 'es2022', sourcemap: true },
  test: {
    // Logic tests run in plain Node. Under jsdom the TextEncoder and Uint8Array come from
    // different realms, and tweetnacl (correctly) refuses bytes that are not instances of the
    // Uint8Array it can see. Real browsers have a single realm, so this is a test-only problem.
    // A test that renders components opts in to a DOM with `// @vitest-environment jsdom`.
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
