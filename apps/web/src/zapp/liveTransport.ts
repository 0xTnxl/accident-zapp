import type { RelayStatus, Transport } from '@accident/protocol';
import type { LiveRoom, Zend } from './appkit.js';
import { EVENT } from '../friend/transports.js';

/**
 * Moves game messages through Zend's live room for the interaction (`zend.live`). Zend checks
 * that only the two players can join. Like every transport here it is untrusted: messages are
 * signed and checked by the session.
 */
const JOIN_TIMEOUT_MS = 8000;

export class ZendLiveTransport implements Transport {
  private room: LiveRoom | undefined;
  private offs: (() => void)[] = [];
  constructor(
    private readonly zend: Zend,
    private readonly interactionId: string,
  ) {}

  async join(
    _room: string,
    handlers: { onMessage(raw: string): void; onStatus(status: RelayStatus): void },
  ): Promise<void> {
    // An older Zend app has no live rooms; don't let it hold up the game. Supabase carries on.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const room = await Promise.race([
      this.zend.live.join(this.interactionId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Zend live room did not answer')), JOIN_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    this.room = room;
    this.offs.push(
      room.on('message', (m) => {
        const raw = (m.data as { e?: unknown; raw?: unknown } | null)?.raw;
        if ((m.data as { e?: unknown } | null)?.e === EVENT && typeof raw === 'string') handlers.onMessage(raw);
      }),
      room.on('status', (s) => handlers.onStatus(s === 'connected' ? 'up' : 'down')),
      room.on('closed', () => handlers.onStatus('down')),
    );
    handlers.onStatus('up');
  }

  async send(_room: string, raw: string): Promise<void> {
    if (!this.room) throw new Error('Not in the live room');
    await this.room.send({ e: EVENT, raw });
  }

  async leave(): Promise<void> {
    for (const off of this.offs) off();
    this.offs = [];
    const room = this.room;
    this.room = undefined;
    await room?.leave().catch(() => undefined);
  }
}

/**
 * Sends every message on all transports and passes on whatever arrives on any of them. Used
 * while Accident moves from Supabase to Zend live rooms: a player whose browser tab or Zend app is
 * older only has Supabase, and still gets every message. Duplicates are harmless; the session
 * expects them. Joining succeeds if at least one transport joins.
 */
export class DualTransport implements Transport {
  private joined: Transport[] = [];
  private up = new Map<Transport, boolean>();
  constructor(private readonly transports: Transport[]) {}

  async join(
    room: string,
    handlers: { onMessage(raw: string): void; onStatus(status: RelayStatus): void },
  ): Promise<void> {
    const report = () => handlers.onStatus([...this.up.values()].some(Boolean) ? 'up' : 'down');
    const results = await Promise.allSettled(
      this.transports.map((t) =>
        t.join(room, {
          onMessage: handlers.onMessage,
          onStatus: (s) => {
            this.up.set(t, s === 'up');
            report();
          },
        }).then(() => t),
      ),
    );
    this.joined = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (this.joined.length === 0) {
      const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      throw first?.reason ?? new Error('No relay could be joined');
    }
  }

  async send(room: string, raw: string): Promise<void> {
    const results = await Promise.allSettled(this.joined.map((t) => t.send(room, raw)));
    // Delivered if any relay took it; the session retries on its own otherwise.
    if (!results.some((r) => r.status === 'fulfilled')) {
      throw (results[0] as PromiseRejectedResult | undefined)?.reason ?? new Error('Not connected');
    }
  }

  async leave(room: string): Promise<void> {
    await Promise.allSettled(this.joined.map((t) => t.leave(room)));
    this.joined = [];
    this.up.clear();
  }
}
