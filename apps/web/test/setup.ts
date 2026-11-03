import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';

/**
 * Logic tests run in plain Node, which has no `localStorage`. Give them an in-memory one with the
 * same behaviour as the browser's (string values, throws nothing on missing keys), reset for every
 * test so nothing leaks between them. Tests that opt in to jsdom keep its real one.
 */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const needsStorage = typeof window === 'undefined';

beforeEach(() => {
  if (needsStorage)
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
    });
});

afterEach(async () => {
  if (!needsStorage) {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    localStorage.clear();
  }
});
