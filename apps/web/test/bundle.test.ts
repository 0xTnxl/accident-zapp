import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Guards the budget and the code-split. The computer game, and the first screen, must stay small,
 * so the heavy chain and relay clients belong only in the lazily loaded friend-mode chunk. If
 * something imports them from the always-loaded entry, the entry grows and this fails.
 */
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const distAssets = fileURLToPath(new URL('../dist/assets', import.meta.url));

function assetFiles(): string[] {
  return readdirSync(distAssets).filter((f) => f.endsWith('.js'));
}

describe('production bundle', () => {
  beforeAll(() => {
    // Build once if the dist is not already present, so the test is self-contained.
    try {
      readdirSync(distAssets);
    } catch {
      execFileSync('pnpm', ['exec', 'vite', 'build'], { cwd: webRoot, stdio: 'ignore' });
    }
  }, 120_000);

  /** The lazily loaded chunk that carries the heavy chain and relay clients. Its exact name
   * depends on how the bundler groups the friend-mode and verifier code, which both pull them in,
   * so it is found by content rather than by a fixed file name. */
  function heavyChunk(): string {
    const entry = assetFiles().find((f) => f.startsWith('index-')) as string;
    const heavy = assetFiles().filter(
      (f) => f !== entry && readFileSync(`${distAssets}/${f}`, 'utf8').includes('supabase'),
    );
    if (heavy.length === 0) throw new Error('no lazy chunk carries the heavy clients');
    // Friend mode and the verifier share one lazily loaded chunk. If the bundler ever split the
    // heavy clients across two chunks, this guard would inspect only one, so pin the expectation.
    expect(heavy.length).toBe(1);
    return heavy[0] as string;
  }

  it('splits friend mode out of the always-loaded entry', () => {
    const files = assetFiles();
    expect(files.some((f) => f.startsWith('index-'))).toBe(true);
    // The friend-mode and verifier code is lazily loaded, so the heavy clients live in a split
    // chunk, not the entry.
    expect(heavyChunk()).not.toMatch(/^index-/);
  });

  it('keeps the always-loaded entry well under the 300 KB gzipped budget', async () => {
    const { gzipSync } = await import('node:zlib');
    const entry = assetFiles().find((f) => f.startsWith('index-')) as string;
    const gz = gzipSync(readFileSync(`${distAssets}/${entry}`)).length;
    // The PRD budget is ~300 KB gzipped for the whole shell. The main entry alone should be far
    // less. Measured at ~138 KB with React 19 + the practice engine + analytics/stats/wake-lock
    // code (no Solana or Supabase, see the test below); 160 KB leaves headroom for incidental
    // growth while still catching a real regression, like the heavy clients leaking into the entry.
    expect(gz).toBeLessThan(160_000);
  });

  it('does not pull the Solana or Supabase clients into the always-loaded entry', () => {
    const entry = assetFiles().find((f) => f.startsWith('index-')) as string;
    const source = readFileSync(`${distAssets}/${entry}`, 'utf8');
    // Fingerprints of the heavy libraries. They belong only in the friend-mode chunk.
    // Minification removes identifier names, so these are strings the libraries ship at runtime.
    expect(source).not.toContain('supabase');
    expect(source).not.toContain('@solana/web3.js');
  });

  it('puts those clients in a lazily loaded chunk, where they belong', () => {
    const source = readFileSync(`${distAssets}/${heavyChunk()}`, 'utf8');
    expect(source.length).toBeGreaterThan(100_000);
    expect(source).toContain('supabase');
  });
});
