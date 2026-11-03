import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Several tests simulate every one of the 5,040 secrets or score every pair of codes. They take
    // a second or two on an idle machine and several times that when a whole workspace runs at once
    // on a busy CI runner, so the default 5 s limit fails them for the wrong reason.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
