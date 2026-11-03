import { roomForInteraction } from '@accident/zend';
import type { SessionView } from '@accident/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { readEnv, readTurnMs } from '../friend/env.js';
import { ActiveRoom } from '../friend/FriendRoot.js';
import { controllerFor } from '../friend/registry.js';
import { loadOrCreateIdentity } from '../friend/vault.js';
import type { Backend } from '../friend/backend.js';
import { Button } from '../ui/Button.js';
import { Shell } from '../ui/Shell.js';
import type { Identity as ZendIdentity, Interaction, Zend } from './appkit.js';
import { createZendBackend, zendAttestKey } from './zendBackend.js';
import { Ladder } from './ladder.js';
import type { LadderView } from './LadderScreens.js';
import { LadderRoot, TOURNAMENT_KEY } from './LadderScreens.js';

/**
 * Accident as a ZApp. A `challenge` interaction is the room:
 *   - its creator (the person who tapped + → Apps → Challenge) is the host, the other person the guest;
 *   - each player uses a fresh game key per interaction, bound to their Zend account by a receipt;
 *   - the host publishes its game key in the interaction so the guest can pin it (the old link
 *     fragment did this);
 *   - commit/reveal records go to Zend, live moves over the relay, and the result goes back to the
 *     interaction plus a card in the chat.
 */

type Ready = {
  interactionId: string;
  room: string;
  role: 'host' | 'guest';
  hostKey: string | undefined;
  identity: ReturnType<typeof loadOrCreateIdentity>;
  vaultKey: string;
  backend: Backend;
  me: ZendIdentity;
  interaction: Interaction;
};

type State =
  | { step: 'loading' }
  | { step: 'no-game' }
  | { step: 'waiting-host'; name: string }
  | { step: 'error'; message: string }
  | ({ step: 'ready' } & Ready);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startFrom(zend: Zend, me: ZendIdentity): Promise<string | null> {
  if (zend.launch.interaction) return zend.launch.interaction;
  // "Rematch" on a result card: a new challenge with the same people.
  if (zend.launch.start === 'challenge' && zend.launch.from) {
    const prev = await zend.interaction.get(zend.launch.from);
    const others = prev.participants.filter((p) => p.appUserId !== me.appUserId).map((p) => p.appUserId);
    return (await zend.interaction.create({ type: 'challenge', participants: others })).id;
  }
  return null;
}

export function ZAppRoot({ zend, onPractice }: { zend: Zend; onPractice: () => void }) {
  const [state, setState] = useState<State>({ step: 'loading' });
  // Opened without a game: a tournament game just ended returns to its lobby.
  const [ladderView, setLadderView] = useState<LadderView | null>(() => {
    const t = sessionStorage.getItem(TOURNAMENT_KEY);
    return t ? { name: 'tournament', id: t } : null;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await zend.identity.get();
        const id = await startFrom(zend, me);
        if (!id) return setState({ step: 'no-game' });
        let interaction = await zend.interaction.get(id);
        const host = interaction.participants[0];
        const role = host?.appUserId === me.appUserId ? 'host' : 'guest';
        const vaultKey = `zapp-${id}`;
        const identity = loadOrCreateIdentity(localStorage, vaultKey);
        const room = await roomForInteraction(id);
        const { backend, chain } = createZendBackend(readEnv(), zend, id, await zendAttestKey());

        let hostKey: string | undefined;
        if (role === 'host') {
          if (interaction.data.hostKey !== identity.publicKey) {
            await zend.interaction.update(id, {
              state: interaction.state, data: { hostKey: identity.publicKey }, idempotencyKey: `${id}:hostKey`,
            });
          }
        } else {
          // Wait for the host to open the game and publish its key.
          while (typeof interaction.data.hostKey !== 'string') {
            if (cancelled) return;
            setState({ step: 'waiting-host', name: host?.name ?? 'your friend' });
            await sleep(2500);
            interaction = await zend.interaction.get(id);
          }
          hostKey = interaction.data.hostKey as string;
          if (interaction.state === 'sent') {
            await zend.interaction.update(id, { state: 'accepted', idempotencyKey: `${id}:accept` }).catch(() => undefined);
          }
        }
        await chain.bindKey(identity).catch(() => undefined);
        if (!cancelled) {
          setState({ step: 'ready', interactionId: id, room, role, hostKey, identity, vaultKey, backend, me, interaction });
        }
      } catch (e) {
        if (!cancelled) setState({ step: 'error', message: e instanceof Error ? e.message : 'Something went wrong' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zend]);

  if (state.step === 'loading') return <Shell title="Accident"><p className="py-6 text-ink-soft" role="status">Loading…</p></Shell>;
  if (state.step === 'waiting-host') {
    return (
      <Shell title="Accident">
        <p className="py-6">Waiting for {state.name} to open the game…</p>
      </Shell>
    );
  }
  if (state.step === 'no-game' && ladderView) {
    return (
      <LadderRoot
        zend={zend}
        view={ladderView}
        go={setLadderView}
        onBack={() => {
          sessionStorage.removeItem(TOURNAMENT_KEY);
          setLadderView(null);
        }}
      />
    );
  }
  if (state.step === 'no-game') {
    return (
      <Shell title="Accident">
        <div className="flex flex-1 flex-col justify-center gap-4">
          <p className="text-lg font-bold">Guess the code before your friend does.</p>
          <p>To play a friend, open a chat with them in Zend, tap +, then Apps, then Challenge.</p>
          <Button onClick={() => setLadderView({ name: 'tournaments' })}>Tournaments</Button>
          <Button tone="plain" onClick={() => setLadderView({ name: 'board' })}>Leaderboard</Button>
          <Button tone="plain" onClick={onPractice}>Practice against the computer</Button>
          <Button tone="plain" onClick={() => void zend.close()}>Back to Zend</Button>
        </div>
      </Shell>
    );
  }
  if (state.step === 'error') {
    return (
      <Shell title="Accident">
        <div className="flex flex-1 flex-col justify-center gap-4">
          <p>That didn't load. Try again in a moment.</p>
          <p className="text-sm text-ink-soft">{state.message.slice(0, 160)}</p>
          <Button onClick={() => void zend.close()}>Back to Zend</Button>
        </div>
      </Shell>
    );
  }
  return <ReadyGame zend={zend} game={state} />;
}

function ReadyGame({ zend, game }: { zend: Zend; game: Ready }) {
  const route = useMemo(
    () => ({ name: 'room' as const, code: game.room, role: game.role, hostKey: game.hostKey }),
    [game.room, game.role, game.hostKey],
  );
  // Same registry key as ActiveRoom, so this is the controller ActiveRoom uses.
  const controller = useMemo(
    () => controllerFor({
      room: game.room, role: game.role, hostKey: game.role === 'host' ? undefined : game.hostKey,
      identity: game.identity, backend: game.backend, player: game.vaultKey, turnMs: readTurnMs(),
    }),
    [game],
  );

  useEffect(() => {
    let reported = false;
    const onView = (v: SessionView | undefined) => {
      if (!v) return;
      if (v.gateOpen) void report(zend, game, 'in_progress');
      if (!reported && v.phase === 'final' && v.verdict?.kind === 'final') {
        reported = true;
        void finish(zend, game, v.verdict.result, v.verdict.faults.map((f) => f.seat)).then(() =>
          // Rate it: the server re-checks the game from this record and Zend's receipts.
          new Ladder(zend)
            .submit(game.interactionId, {
              room: game.room,
              messages: controller.transcript().map((l) => JSON.parse(l) as unknown),
            })
            .catch(() => undefined),
        );
      }
    };
    onView(controller.view());
    return controller.onView(onView);
  }, [controller, zend, game]);

  const rematch = useCallback(() => {
    void (async () => {
      const others = game.interaction.participants.filter((p) => p.appUserId !== game.me.appUserId).map((p) => p.appUserId);
      const next = await zend.interaction.create({ type: 'challenge', participants: others });
      window.location.search = `?interaction=${encodeURIComponent(next.id)}`;
    })();
  }, [zend, game]);

  return (
    <ActiveRoom
      route={route}
      backend={game.backend}
      go={() => void zend.close()}
      vaultKey={game.vaultKey}
      // A tournament game goes back to the tournament; any other game closes Accident.
      leave={() => (sessionStorage.getItem(TOURNAMENT_KEY) ? (window.location.search = '') : void zend.close())}
      rematch={rematch}
    />
  );
}

const reportedStates = new Set<string>();
async function report(zend: Zend, game: Ready, state: 'in_progress') {
  const key = `${game.interactionId}:${state}`;
  if (reportedStates.has(key)) return;
  reportedStates.add(key);
  await zend.interaction.update(game.interactionId, { state, idempotencyKey: key }).catch(() => undefined);
}

/**
 * Both players report the same verdict (idempotency makes the second a no-op). Only the host posts
 * the chat card, so it appears once. Anyone can re-check the verdict from the Zend receipts.
 */
async function finish(zend: Zend, game: Ready, result: 'seat0' | 'seat1' | 'draw', faultySeats: number[]) {
  const [host, guest] = game.interaction.participants;
  const name = (p: typeof host) => p?.name || (p?.username ? `@${p.username}` : 'Someone');
  const winner = result === 'seat0' ? host : result === 'seat1' ? guest : undefined;
  const loser = result === 'seat0' ? guest : result === 'seat1' ? host : undefined;
  const cheated = faultySeats.length === 1;
  await zend.interaction.update(game.interactionId, {
    state: 'resolved',
    data: { result, winner: winner?.appUserId ?? null, faults: faultySeats },
    idempotencyKey: `${game.interactionId}:resolve`,
  }).catch(() => undefined);
  if (game.role !== 'host') return;
  const title = winner
    ? cheated
      ? `${name(winner)} wins. ${name(loser)}'s answers didn't add up`
      : `${name(winner)} beat ${name(loser)} at Accident`
    : `${name(host)} and ${name(guest)} drew at Accident`;
  await zend.postCard({
    interactionId: game.interactionId,
    template: 'result',
    placement: 'chat',
    idempotencyKey: `${game.interactionId}:card`,
    slots: {
      title: title.slice(0, 80),
      emoji: winner ? '😂' : '🤝',
      subtitle: 'Checked afterwards so nobody can cheat',
      buttons: [{ label: 'Rematch', action: 'start_interaction', type: 'challenge' }],
    },
  }).catch(() => undefined);
}
