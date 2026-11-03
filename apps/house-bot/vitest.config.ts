import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // These tests drive a real protocol Session through a ManualClock across a full game; coverage
    // instrumentation slows them down, same as packages/protocol and packages/engine.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/index.ts is a pure re-export barrel (excluded repo-wide, see engine/protocol configs).
      // src/live.ts wires real Solana/transport adapters for manual runs only: it performs no I/O
      // at import time and is never imported by a test, so it is excluded from the coverage bar.
      exclude: ['src/index.ts', 'src/live.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
