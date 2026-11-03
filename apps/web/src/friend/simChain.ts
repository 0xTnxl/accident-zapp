import type { Chain, Identity, MemoTx } from '@accident/protocol';
import { parseMemo } from '@accident/protocol';
import bs58 from 'bs58';

const PREFIX = 'accident:sim-tx:v2:';

/** The storage operations the ledger needs. `localStorage` provides all of them. */
export interface LedgerStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  key(index: number): string | null;
  readonly length: number;
}

type Stored = MemoTx & { at: number };

/**
 * A pretend Solana for development and demos: Memo transactions kept in localStorage, shared by
 * every tab of the same browser. It implements the same `Chain` port as the real adapter, so a
 * whole friend game runs through the real session and protocol code, but it is NOT a blockchain.
 * Nothing it records is public or permanent, and the interface says so wherever it is active.
 *
 * Every transaction lives under its own key. An earlier version kept one shared list and rewrote
 * it on each send, and two tabs committing at the same moment overwrote each other's transaction.
 * Tabs are separate threads, so a read-then-write of one shared value is a race. One key per
 * transaction means concurrent writers never touch the same entry.
 */
export class SimChain implements Chain {
  /** `confirmMs` is how long a new transaction takes to count as confirmed, like a real cluster. */
  constructor(
    private readonly store: LedgerStore = localStorage,
    private readonly confirmMs = 700,
    private readonly now: () => number = Date.now,
  ) {}

  private all(): Stored[] {
    const out: Stored[] = [];
    for (let i = 0; i < this.store.length; i++) {
      const key = this.store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const tx = JSON.parse(this.store.getItem(key) ?? 'null') as Stored | null;
        if (tx && typeof tx.sig === 'string') out.push(tx);
      } catch {
        // A damaged entry is skipped; it must not hide the rest of the ledger.
      }
    }
    return out;
  }

  private confirmed(): MemoTx[] {
    const now = this.now();
    return this.all()
      .filter((tx) => now - tx.at >= this.confirmMs)
      .sort((a, b) => a.slot - b.slot)
      .map(({ at: _at, ...tx }) => tx);
  }

  async sendMemo(signer: Identity, text: string): Promise<string> {
    // Random bytes make a collision between two tabs effectively impossible, so no shared counter
    // (another race) is needed. The time is the slot, so ordering follows real time.
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    const sig = bs58.encode(bytes);
    const at = this.now();
    const tx: Stored = {
      sig,
      signer: signer.publicKey,
      text,
      slot: at,
      blockTime: Math.floor(at / 1000),
      ok: true,
      at,
    };
    this.store.setItem(`${PREFIX}${sig}`, JSON.stringify(tx));
    return sig;
  }

  async getMemoTx(sig: string): Promise<MemoTx | null> {
    return this.confirmed().find((tx) => tx.sig === sig) ?? null;
  }

  async listMemoTxs(address: string, room: string): Promise<MemoTx[]> {
    return this.confirmed().filter(
      (tx) => tx.signer === address && parseMemo(tx.text)?.room === room,
    );
  }
}
