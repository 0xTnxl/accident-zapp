import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WakeLockApi, WakeLockEnv, WakeLockSentinelLike } from '../src/friend/wakeLock.js';
import { WakeLock } from '../src/friend/wakeLock.js';

/** A fake wake-lock sentinel that records releases and can fire the browser's release event. */
class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private listeners: Array<() => void> = [];
  release = vi.fn(async () => {
    this.released = true;
    this.fire();
  });
  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.push(listener);
  }
  /** Simulates the browser dropping the lock (for example when the tab is hidden). */
  fire(): void {
    this.released = true;
    for (const l of this.listeners) l();
  }
}

/** A controllable environment: visibility is a flag the test flips, and requests can be made to fail. */
function makeEnv(options: { supported?: boolean; visible?: boolean } = {}) {
  let visible = options.visible ?? true;
  const visibilityListeners = new Set<() => void>();
  const sentinels: FakeSentinel[] = [];
  let failNext = false;

  const api: WakeLockApi = {
    request: vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw new Error('denied');
      }
      const s = new FakeSentinel();
      sentinels.push(s);
      return s;
    }),
  };
  const env: WakeLockEnv = {
    wakeLock: options.supported === false ? undefined : api,
    isVisible: () => visible,
    addVisibilityListener: (listener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
  };
  return {
    env,
    api,
    sentinels,
    setVisible(next: boolean) {
      visible = next;
      for (const l of visibilityListeners) l();
    },
    failNextRequest() {
      failNext = true;
    },
    get listenerCount() {
      return visibilityListeners.size;
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WakeLock', () => {
  it('reports whether the browser supports it', () => {
    expect(new WakeLock(makeEnv().env).supported).toBe(true);
    expect(new WakeLock(makeEnv({ supported: false }).env).supported).toBe(false);
  });

  it('acquires a lock when engaged while visible', async () => {
    const h = makeEnv();
    const lock = new WakeLock(h.env);
    lock.engage();
    await flush();
    expect(h.api.request).toHaveBeenCalledWith('screen');
    expect(lock.held).toBe(true);
  });

  it('does nothing but stays ready when the API is missing', async () => {
    const h = makeEnv({ supported: false });
    const lock = new WakeLock(h.env);
    lock.engage();
    await flush();
    expect(lock.held).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('does not acquire while the tab is hidden, and acquires when it becomes visible', async () => {
    const h = makeEnv({ visible: false });
    const lock = new WakeLock(h.env);
    lock.engage();
    await flush();
    expect(lock.held).toBe(false);
    h.setVisible(true);
    await flush();
    expect(lock.held).toBe(true);
  });

  it('re-acquires after the browser drops the lock on hide and the tab returns', async () => {
    const h = makeEnv();
    const lock = new WakeLock(h.env);
    lock.engage();
    await flush();
    expect(lock.held).toBe(true);

    // The browser hides the tab: it fires release and we go hidden.
    h.sentinels[0]?.fire();
    h.setVisible(false);
    await flush();
    expect(lock.held).toBe(false);

    h.setVisible(true);
    await flush();
    expect(lock.held).toBe(true);
    expect(h.api.request).toHaveBeenCalledTimes(2);
    expect(h.sentinels).toHaveLength(2);
  });

  it('releases the lock and stops listening when released', async () => {
    const h = makeEnv();
    const lock = new WakeLock(h.env);
    lock.engage();
    await flush();
    const sentinel = h.sentinels[0];
    await lock.release();
    expect(sentinel?.release).toHaveBeenCalled();
    expect(lock.held).toBe(false);
    expect(h.listenerCount).toBe(0);
    // After release, becoming visible must not silently re-acquire.
    h.setVisible(true);
    await flush();
    expect(lock.held).toBe(false);
  });

  it('the function returned by engage also releases', async () => {
    const h = makeEnv();
    const lock = new WakeLock(h.env);
    const stop = lock.engage();
    await flush();
    stop();
    await flush();
    expect(lock.held).toBe(false);
  });

  it('engage is idempotent: a second call does not add a second lock or listener', async () => {
    const h = makeEnv();
    const lock = new WakeLock(h.env);
    lock.engage();
    lock.engage();
    await flush();
    expect(h.api.request).toHaveBeenCalledTimes(1);
    expect(h.listenerCount).toBe(1);
  });

  it('survives the browser refusing the request, and recovers on the next visibility change', async () => {
    const h = makeEnv();
    const lock = new WakeLock(h.env);
    h.failNextRequest();
    lock.engage();
    await flush();
    expect(lock.held).toBe(false);
    // Toggling away and back triggers another attempt, which succeeds.
    h.setVisible(false);
    h.setVisible(true);
    await flush();
    expect(lock.held).toBe(true);
  });

  it('does not keep a lock that arrives after release was already called', async () => {
    const h = makeEnv();
    let resolveRequest: (s: WakeLockSentinelLike) => void = () => undefined;
    const slow = new FakeSentinel();
    (h.api.request as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<WakeLockSentinelLike>((resolve) => (resolveRequest = resolve)),
    );
    const lock = new WakeLock(h.env);
    lock.engage();
    await lock.release(); // release before the slow request resolves
    resolveRequest(slow);
    await flush();
    expect(lock.held).toBe(false);
    expect(slow.release).toHaveBeenCalled();
  });

  it('does not stack requests if visibility flips rapidly while one is in flight', async () => {
    const h = makeEnv();
    const lock = new WakeLock(h.env);
    lock.engage();
    h.setVisible(true);
    h.setVisible(true);
    await flush();
    expect(h.api.request).toHaveBeenCalledTimes(1);
  });
});
