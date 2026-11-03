import type { RelayStatus, Transport } from '@accident/protocol';

/** The event name every game message travels under. */
export const EVENT = 'acc';

// --------------------------------------------------------------------------- Supabase Realtime

/**
 * The small part of a Supabase Realtime channel this adapter uses. Supabase's own client satisfies
 * it, and a test can supply a fake, so nothing here needs a live project to be checked.
 */
export interface RealtimeChannelLike {
  on(
    type: 'broadcast',
    filter: { event: string },
    callback: (message: { payload?: unknown }) => void,
  ): RealtimeChannelLike;
  subscribe(callback: (status: string, error?: Error) => void): RealtimeChannelLike;
  send(message: { type: 'broadcast'; event: string; payload: unknown }): Promise<string>;
}

export interface RealtimeClientLike {
  channel(
    name: string,
    options: { config: { broadcast: { self: boolean; ack: boolean } } },
  ): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>;
}

/**
 * Relays messages through a Supabase Realtime Broadcast channel named after the room.
 *
 * Nothing here is trusted. The relay can drop, delay, repeat or reorder messages and can be joined
 * by anyone who knows the room code, and the session copes with all of that because every message
 * is signed and checked. This adapter only moves strings.
 */
export class SupabaseTransport implements Transport {
  private channel: RealtimeChannelLike | undefined;

  constructor(private readonly client: RealtimeClientLike) {}

  join(
    room: string,
    handlers: { onMessage(raw: string): void; onStatus(status: RelayStatus): void },
  ): Promise<void> {
    // No self-echo: we never need our own messages back. `ack` makes send() wait for the server.
    const channel = this.client.channel(`accident:${room}`, {
      config: { broadcast: { self: false, ack: true } },
    });
    this.channel = channel;
    channel.on('broadcast', { event: EVENT }, (message) => {
      const raw = (message.payload as { raw?: unknown } | undefined)?.raw;
      if (typeof raw === 'string') handlers.onMessage(raw);
    });
    return new Promise<void>((resolve) => {
      let resolved = false;
      channel.subscribe((status) => {
        // SUBSCRIBED is reported on the first connection and on every reconnect.
        handlers.onStatus(status === 'SUBSCRIBED' ? 'up' : 'down');
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
    });
  }

  async send(_room: string, raw: string): Promise<void> {
    if (!this.channel) throw new Error('Not connected to the relay');
    const result = await this.channel.send({ type: 'broadcast', event: EVENT, payload: { raw } });
    if (result !== 'ok') throw new Error(`The relay did not accept the message (${result})`);
  }

  async leave(): Promise<void> {
    const channel = this.channel;
    this.channel = undefined;
    if (channel) await this.client.removeChannel(channel);
  }
}

// --------------------------------------------------------------------------- Same-browser channel

/** The part of `BroadcastChannel` this adapter uses. */
export interface BroadcastChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

/**
 * Carries messages between tabs of the same browser, with no server. It exists for development
 * and for the simulation backend, so a whole friend game can be played against yourself in two
 * tabs. It is not a real network and the UI says so.
 */
export class TabTransport implements Transport {
  private channel: BroadcastChannelLike | undefined;

  constructor(
    private readonly create: (name: string) => BroadcastChannelLike = (name) =>
      new BroadcastChannel(name) as unknown as BroadcastChannelLike,
  ) {}

  async join(
    room: string,
    handlers: { onMessage(raw: string): void; onStatus(status: RelayStatus): void },
  ): Promise<void> {
    const channel = this.create(`accident:${room}`);
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') handlers.onMessage(event.data);
    };
    this.channel = channel;
    handlers.onStatus('up');
  }

  async send(_room: string, raw: string): Promise<void> {
    if (!this.channel) throw new Error('Not connected');
    this.channel.postMessage(raw);
  }

  async leave(): Promise<void> {
    this.channel?.close();
    this.channel = undefined;
  }
}
