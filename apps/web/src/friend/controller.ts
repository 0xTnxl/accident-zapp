import type { Code } from '@accident/engine';
import type { Identity, Role, SessionView } from '@accident/protocol';
import { Session, generateSaltHex } from '@accident/protocol';
import type { Backend, FundResult } from './backend.js';
import { LocalSessionStorage, realClock, requestPersistence } from './vault.js';

/** What the player sees while the game is being set up, before the session takes over. */
export type SetupState =
  | { step: 'idle' }
  | { step: 'funding' }
  | { step: 'funding-failed'; reason: string }
  | { step: 'ready' };

export interface ControllerInit {
  room: string;
  role: Role;
  hostKey: string | undefined;
  identity: Identity;
  backend: Backend;
  /** Simulation only: names this tab's player so its saved game stays separate. */
  player?: string | undefined;
  /** How long the player on the clock has before the other side may claim a timeout, in ms. */
  turnMs?: number | undefined;
}

/** The secret and salt the player chose, kept until the session has saved them. */
export interface Choice {
  secret: Code;
  saltHex: string;
}

export function newChoice(secret: Code): Choice {
  return { secret, saltHex: generateSaltHex() };
}

/**
 * Owns one friend game on this device: funds the burner key, builds the session from the backend's
 * adapters, and hands the UI a stream of views. All decisions live in `Session`; this only wires it.
 */
export class FriendController {
  private session: Session | undefined;
  private unsubscribe: (() => void) | undefined;
  private listeners = new Set<(view: SessionView | undefined) => void>();
  private setupListeners = new Set<(state: SetupState) => void>();
  private setup: SetupState = { step: 'idle' };
  private disposed = false;

  constructor(private readonly init: ControllerInit) {}

  get room(): string {
    return this.init.room;
  }

  get role(): Role {
    return this.init.role;
  }

  get backend(): Backend {
    return this.init.backend;
  }

  get identity(): Identity {
    return this.init.identity;
  }

  state(): SetupState {
    return this.setup;
  }

  view(): SessionView | undefined {
    return this.session?.view();
  }

  transcript(): string[] {
    return this.session?.transcript() ?? [];
  }

  onView(listener: (view: SessionView | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onSetup(listener: (state: SetupState) => void): () => void {
    this.setupListeners.add(listener);
    return () => this.setupListeners.delete(listener);
  }

  private setSetup(state: SetupState): void {
    this.setup = state;
    for (const listener of [...this.setupListeners]) listener(state);
  }

  private emit(view: SessionView | undefined): void {
    for (const listener of [...this.listeners]) listener(view);
  }

  /**
   * Picks up a game that was interrupted, if one was saved on this device. Returns whether there
   * was one. The player's secret is in the saved game, so nothing is asked of them again.
   */
  async resume(): Promise<boolean> {
    const session = await Session.resume({
      room: this.init.room,
      identity: this.init.identity,
      transport: this.init.backend.transport(),
      chain: this.init.backend.chain,
      storage: new LocalSessionStorage(localStorage, this.init.player),
      clock: realClock,
      ...(this.init.turnMs === undefined ? {} : { options: { turnMs: this.init.turnMs } }),
    });
    if (!session) return false;
    await this.attach(session);
    return true;
  }

  /** Funds the key if needed, then starts a new game with the player's chosen secret. */
  async begin(choice: Choice): Promise<void> {
    if (this.session || this.disposed) return;
    this.setSetup({ step: 'funding' });
    const funded: FundResult = await this.init.backend.fund(this.init.identity.publicKey);
    if (this.disposed) return;
    if (!funded.ok) {
      this.setSetup({ step: 'funding-failed', reason: funded.reason });
      return;
    }
    this.setSetup({ step: 'ready' });
    void requestPersistence();
    const session = Session.create({
      room: this.init.room,
      role: this.init.role,
      identity: this.init.identity,
      secret: choice.secret,
      saltHex: choice.saltHex,
      ...(this.init.hostKey === undefined ? {} : { hostKey: this.init.hostKey }),
      transport: this.init.backend.transport(),
      chain: this.init.backend.chain,
      storage: new LocalSessionStorage(localStorage, this.init.player),
      clock: realClock,
      ...(this.init.turnMs === undefined ? {} : { options: { turnMs: this.init.turnMs } }),
    });
    await this.attach(session);
  }

  private async attach(session: Session): Promise<void> {
    this.session = session;
    this.unsubscribe = session.subscribe((view) => this.emit(view));
    await session.start();
    this.emit(session.view());
  }

  async guess(code: string): Promise<void> {
    await this.session?.submitGuess(code);
  }

  async claimTimeout(): Promise<void> {
    await this.session?.claimTimeout();
  }

  async retry(): Promise<void> {
    await this.session?.retry();
  }

  /** Stops everything. The saved game stays on the device so it can be resumed. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe?.();
    await this.session?.close();
    this.session = undefined;
  }
}
