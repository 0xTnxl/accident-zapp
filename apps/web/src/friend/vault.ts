import type { Identity } from '@accident/protocol';
import { generateIdentity, identityFromSecretKey } from '@accident/protocol';
import type { Storage as SessionStorage } from '@accident/protocol';

/**
 * The player's burner key and anything else that must survive a refresh.
 *
 * A burner key holds only worthless devnet SOL, so keeping it in browser storage is acceptable.
 * It is written to localStorage, which every browser supports, and the browser is asked to treat
 * the storage as persistent so it is not cleared under storage pressure.
 */
const KEY = 'accident:burner:v1';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The storage key for the burner key, optionally for a named player.
 *
 * Only the simulation build uses a name: two tabs of one browser share storage, so without it they
 * would be the same player and could not play each other. A real device has exactly one player.
 */
export function burnerKey(player?: string): string {
  return player ? `${KEY}:${player}` : KEY;
}

function parseKey(raw: string | null): Identity | undefined {
  if (raw === null) return undefined;
  try {
    const bytes = JSON.parse(raw) as unknown;
    if (!Array.isArray(bytes) || bytes.length !== 64) return undefined;
    if (!bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return undefined;
    return identityFromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    // Corrupt JSON, or a key whose two halves disagree: treat as no key.
    return undefined;
  }
}

/**
 * The player's burner identity: the saved one, or a new one that is saved straight away.
 * A damaged saved key is replaced, since a key that cannot be read is worthless anyway.
 */
export function loadOrCreateIdentity(
  store: KeyValueStore = localStorage,
  player?: string,
): Identity {
  const saved = parseKey(store.getItem(burnerKey(player)));
  if (saved) return saved;
  const fresh = generateIdentity();
  store.setItem(burnerKey(player), JSON.stringify([...fresh.secretKey]));
  return fresh;
}

/** True if a readable key is saved. */
export function hasIdentity(store: KeyValueStore = localStorage, player?: string): boolean {
  return parseKey(store.getItem(burnerKey(player))) !== undefined;
}

/** Asks the browser not to evict our storage. Returns whether storage is now persistent. */
export async function requestPersistence(
  nav: { storage?: { persist?: () => Promise<boolean> } } = navigator,
): Promise<boolean> {
  try {
    return (await nav.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** The protocol's storage port, backed by localStorage. */
export class LocalSessionStorage implements SessionStorage {
  constructor(
    private readonly store: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
    /** Simulation only: keeps two tabs of one browser from sharing a saved game. */
    private readonly player?: string,
  ) {}

  private name(key: string): string {
    return this.player ? `${key}:${this.player}` : key;
  }

  async get(key: string): Promise<string | null> {
    return this.store.getItem(this.name(key));
  }

  async set(key: string, value: string): Promise<void> {
    // A thrown quota error reaches the session, which reports it instead of carrying on unsaved.
    this.store.setItem(this.name(key), value);
  }
}

/** The protocol's clock port, backed by the real one. */
export const realClock = {
  now: (): number => Date.now(),
  setTimeout: (fn: () => void, ms: number): (() => void) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};
