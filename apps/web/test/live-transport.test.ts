import type { RelayStatus, Transport } from '@accident/protocol';
import { describe, expect, it } from 'vitest';
import { DualTransport, ZendLiveTransport } from '../src/zapp/liveTransport.js';
import type { Zend } from '../src/zapp/appkit.js';

type Handlers = { onMessage(raw: string): void; onStatus(status: RelayStatus): void };

class FakeTransport implements Transport {
  handlers: Handlers | undefined;
  sent: string[] = [];
  constructor(
    private readonly failJoin = false,
    private readonly failSend = false,
  ) {}
  async join(_room: string, handlers: Handlers): Promise<void> {
    if (this.failJoin) throw new Error('join failed');
    this.handlers = handlers;
    handlers.onStatus('up');
  }
  async send(_room: string, raw: string): Promise<void> {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(raw);
  }
  async leave(): Promise<void> {}
}

function collect() {
  const got: string[] = [];
  const status: RelayStatus[] = [];
  return { got, status, handlers: { onMessage: (r: string) => got.push(r), onStatus: (s: RelayStatus) => status.push(s) } };
}

describe('DualTransport', () => {
  it('sends on every relay and passes on messages from any of them', async () => {
    const supabase = new FakeTransport();
    const zend = new FakeTransport();
    const dual = new DualTransport([supabase, zend]);
    const c = collect();
    await dual.join('ABCDEF', c.handlers);
    await dual.send('ABCDEF', 'm1');
    expect(supabase.sent).toEqual(['m1']);
    expect(zend.sent).toEqual(['m1']);
    supabase.handlers?.onMessage('from-old-client');
    zend.handlers?.onMessage('from-new-client');
    expect(c.got).toEqual(['from-old-client', 'from-new-client']);
  });

  it('keeps playing on Supabase when the Zend room is unavailable', async () => {
    const supabase = new FakeTransport();
    const dual = new DualTransport([supabase, new FakeTransport(true)]);
    const c = collect();
    await dual.join('ABCDEF', c.handlers);
    await dual.send('ABCDEF', 'm1');
    expect(supabase.sent).toEqual(['m1']);
    expect(c.status.at(-1)).toBe('up');
  });

  it('counts a send as delivered if one relay took it', async () => {
    const dual = new DualTransport([new FakeTransport(false, true), new FakeTransport()]);
    await dual.join('ABCDEF', collect().handlers);
    await expect(dual.send('ABCDEF', 'm1')).resolves.toBeUndefined();
  });

  it('fails only when no relay can be joined', async () => {
    const dual = new DualTransport([new FakeTransport(true), new FakeTransport(true)]);
    await expect(dual.join('ABCDEF', collect().handlers)).rejects.toThrow('join failed');
  });
});

describe('ZendLiveTransport', () => {
  it('gives up on a Zend app that never answers, without blocking', async () => {
    const zend = { live: { join: () => new Promise(() => undefined) } } as unknown as Zend;
    const t = new ZendLiveTransport(zend, 'int_abcdefghjkmn');
    const started = Date.now();
    await expect(t.join('ABCDEF', collect().handlers)).rejects.toThrow('did not answer');
    expect(Date.now() - started).toBeLessThan(9000);
  }, 12_000);

  it('only passes on game messages', async () => {
    let onMessage: ((m: { from: string; data: unknown; at: string }) => void) | undefined;
    const room = {
      on: (event: string, fn: never) => {
        if (event === 'message') onMessage = fn;
        return () => undefined;
      },
      send: async () => undefined,
      leave: async () => undefined,
    };
    const zend = { live: { join: async () => room } } as unknown as Zend;
    const t = new ZendLiveTransport(zend, 'int_abcdefghjkmn');
    const c = collect();
    await t.join('ABCDEF', c.handlers);
    onMessage?.({ from: 'zu_a', data: { e: 'acc', raw: 'game' }, at: '' });
    onMessage?.({ from: 'zu_a', data: { e: 'other', raw: 'not-game' }, at: '' });
    expect(c.got).toEqual(['game']);
  });
});
