/**
 * Keeps the screen awake during a friend game.
 *
 * This is the project's highest-likelihood risk (PRD R1): a phone that sleeps stops answering the
 * opponent automatically, so the game stalls. The Screen Wake Lock API prevents the sleep where it
 * is supported. It is not supported everywhere, and the browser releases the lock whenever the tab
 * is hidden, so the lock is re-acquired when the tab becomes visible again. None of this is a
 * guarantee: the UI also shows a warning and the 180 s timeout still applies.
 */

export interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** The small part of the environment this needs, so tests supply a fake instead of a real browser. */
export interface WakeLockEnv {
  wakeLock: WakeLockApi | undefined;
  /** Document visibility, read fresh each time; the browser drops the lock while hidden. */
  isVisible(): boolean;
  addVisibilityListener(listener: () => void): () => void;
}

export function browserWakeLockEnv(): WakeLockEnv {
  const nav = navigator as Navigator & { wakeLock?: WakeLockApi };
  return {
    wakeLock: nav.wakeLock,
    isVisible: () => document.visibilityState === 'visible',
    addVisibilityListener: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

/**
 * Holds a screen wake lock for as long as it is engaged and the tab is visible, re-acquiring it
 * after the tab returns to the foreground. Call {@link engage} when a game starts and the returned
 * function (or {@link WakeLock.release}) when it ends.
 */
export class WakeLock {
  private sentinel: WakeLockSentinelLike | undefined;
  private engaged = false;
  private acquiring = false;
  private stopVisibility: (() => void) | undefined;

  constructor(private readonly env: WakeLockEnv) {}

  /** Whether the browser offers the API at all. The UI uses this to decide what warning to show. */
  get supported(): boolean {
    return this.env.wakeLock !== undefined;
  }

  /** True while a lock is actually held. */
  get held(): boolean {
    return this.sentinel !== undefined && !this.sentinel.released;
  }

  /** Starts holding the lock. Returns a function that releases it. Safe to call more than once. */
  engage(): () => void {
    if (!this.engaged) {
      this.engaged = true;
      this.stopVisibility = this.env.addVisibilityListener(() => void this.onVisibilityChange());
      void this.acquire();
    }
    return () => void this.release();
  }

  async release(): Promise<void> {
    this.engaged = false;
    this.stopVisibility?.();
    this.stopVisibility = undefined;
    const sentinel = this.sentinel;
    this.sentinel = undefined;
    if (sentinel && !sentinel.released) {
      await sentinel.release().catch(() => undefined);
    }
  }

  private async acquire(): Promise<void> {
    if (!this.engaged || this.acquiring || this.held) return;
    if (!this.env.wakeLock || !this.env.isVisible()) return;
    this.acquiring = true;
    try {
      const sentinel = await this.env.wakeLock.request('screen');
      if (!this.engaged) {
        // Released while the request was in flight; do not keep a lock nobody wants.
        await sentinel.release().catch(() => undefined);
        return;
      }
      this.sentinel = sentinel;
      // The browser auto-releases on hide; drop our reference so the next visible event re-acquires.
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = undefined;
      });
    } catch {
      // Denied (for example low battery). The warning and the timeout cover this.
    } finally {
      this.acquiring = false;
    }
  }

  private async onVisibilityChange(): Promise<void> {
    if (this.engaged && this.env.isVisible()) await this.acquire();
  }
}
