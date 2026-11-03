import type { SessionView } from '@accident/protocol';
import { useEffect, useRef } from 'react';
import type { Analytics } from './analytics.js';
import type { WakeLock } from './wakeLock.js';

export interface GameEffectsDeps {
  wakeLock: WakeLock;
  analytics: Analytics;
  role: 'host' | 'guest';
}

/**
 * The side effects that run alongside a friend game: hold the screen awake while playing, and send
 * the anonymous analytics events as the game reaches each milestone.
 *
 * It is driven purely by the view's phase, so it stays in step with the one source of truth and
 * never fires an event twice. Pulled out of the screen so both are easy to test in isolation.
 */
export function useGameEffects(view: SessionView | undefined, deps: GameEffectsDeps): void {
  const { wakeLock, analytics, role } = deps;
  const phase = view?.phase;

  // Hold the screen awake only while actually playing, and let it sleep otherwise.
  useEffect(() => {
    if (phase === 'playing') return wakeLock.engage();
    return undefined;
  }, [phase, wakeLock]);

  // Fire-once analytics milestones. A ref remembers what has already been reported for this game.
  const reported = useRef<Set<string>>(new Set());
  const once = (key: string, send: () => void): void => {
    if (reported.current.has(key)) return;
    reported.current.add(key);
    send();
  };
  const startedAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!view) return;
    once(`room:${role}`, () =>
      analytics.send(role === 'host' ? { name: 'room_created' } : { name: 'room_joined' }),
    );
    if (view.gateOpen) {
      once('gate', () => {
        startedAt.current = Date.now();
        analytics.send({ name: 'play_gate_open', ms: 0 });
      });
    }
    if (view.phase === 'playing' && view.guesses.length > 0) {
      once('first-guess', () => analytics.send({ name: 'pvp_first_guess' }));
    }
    if (view.phase === 'final' && view.verdict?.kind === 'final') {
      const verdict = view.verdict;
      once('finished', () => {
        const mine = view.guesses.filter((_g, i) => i % 2 === view.seat).length;
        const won = verdict.result === (view.seat === 0 ? 'seat0' : 'seat1');
        analytics.send({
          name: 'pvp_finished',
          result: verdict.result === 'draw' ? 'draw' : won ? 'win' : 'loss',
          guesses: mine,
          durationMs: startedAt.current ? Date.now() - startedAt.current : 0,
        });
      });
    }
    if (view.error) {
      once(`error:${view.error.code}`, () =>
        analytics.send({ name: 'tx_error', kind: view.error?.code ?? 'internal', code: 'client' }),
      );
    }
  }, [view, analytics, role]);
}
