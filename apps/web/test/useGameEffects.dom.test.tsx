// @vitest-environment jsdom
import type { SessionView } from '@accident/protocol';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analytics } from '../src/friend/analytics.js';
import type { AnalyticsEvent, Transport } from '../src/friend/analytics.js';
import { useGameEffects } from '../src/friend/useGameEffects.js';
import { WakeLock } from '../src/friend/wakeLock.js';
import type { WakeLockEnv } from '../src/friend/wakeLock.js';

function baseView(over: Partial<SessionView> = {}): SessionView {
  return {
    phase: 'connecting',
    room: 'ABC234',
    role: 'host',
    seat: 0,
    peerKey: undefined,
    relay: 'up',
    myCommit: 'none',
    peerCommit: 'none',
    gateOpen: false,
    gateOpenedAt: undefined,
    gameOverAt: undefined,
    myReveal: 'none',
    peerReveal: 'none',
    records: {
      mine: { commit: undefined, reveal: undefined },
      peer: { commit: undefined, reveal: undefined },
    },
    guesses: [],
    answers: [],
    status: { over: false, next: 0, index: 0, finalGuess: false },
    canGuess: false,
    onClock: undefined,
    timeoutClaimable: false,
    verdict: undefined,
    outcome: undefined,
    abandonReason: undefined,
    error: undefined,
    violations: 0,
    ...over,
  };
}

function fakeWakeLock() {
  const calls: string[] = [];
  const env: WakeLockEnv = {
    wakeLock: {
      request: async () => {
        calls.push('request');
        return {
          released: false,
          release: async () => void calls.push('release'),
          addEventListener: () => undefined,
        };
      },
    },
    isVisible: () => true,
    addVisibilityListener: () => () => undefined,
  };
  return { lock: new WakeLock(env), calls };
}

function captureAnalytics() {
  const sent: AnalyticsEvent[] = [];
  const transport: Transport = (_url, body) => {
    const { name, props } = JSON.parse(body) as { name: string; props: Record<string, unknown> };
    sent.push({ name, ...props } as AnalyticsEvent);
  };
  return { analytics: new Analytics({ transport, session: 'test' }), sent };
}

function Harness({
  view,
  lock,
  analytics,
  role,
}: {
  view: SessionView | undefined;
  lock: WakeLock;
  analytics: Analytics;
  role: 'host' | 'guest';
}) {
  useGameEffects(view, { wakeLock: lock, analytics, role });
  return null;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wake lock during a game', () => {
  it('engages only while playing and releases when leaving the playing phase', async () => {
    const { lock, calls } = fakeWakeLock();
    const { analytics } = captureAnalytics();
    const { rerender, unmount } = render(
      <Harness
        view={baseView({ phase: 'playing', gateOpen: true })}
        lock={lock}
        analytics={analytics}
        role="host"
      />,
    );
    await flush();
    expect(calls).toContain('request');

    rerender(
      <Harness
        view={baseView({ phase: 'revealing', gateOpen: true })}
        lock={lock}
        analytics={analytics}
        role="host"
      />,
    );
    await flush();
    expect(calls).toContain('release');
    unmount();
  });

  it('does not engage while merely connecting or waiting at the gate', async () => {
    const { lock, calls } = fakeWakeLock();
    const { analytics } = captureAnalytics();
    render(
      <Harness view={baseView({ phase: 'gate' })} lock={lock} analytics={analytics} role="host" />,
    );
    await flush();
    expect(calls).not.toContain('request');
  });

  it('releases the lock when the component unmounts', async () => {
    const { lock, calls } = fakeWakeLock();
    const { analytics } = captureAnalytics();
    const { unmount } = render(
      <Harness
        view={baseView({ phase: 'playing', gateOpen: true })}
        lock={lock}
        analytics={analytics}
        role="host"
      />,
    );
    await flush();
    unmount();
    await flush();
    expect(calls).toContain('release');
  });
});

describe('analytics milestones', () => {
  it('reports room_created for the host and room_joined for the guest, once', () => {
    const host = captureAnalytics();
    const { rerender } = render(
      <Harness
        view={baseView()}
        lock={fakeWakeLock().lock}
        analytics={host.analytics}
        role="host"
      />,
    );
    rerender(
      <Harness
        view={baseView({ relay: 'down' })}
        lock={fakeWakeLock().lock}
        analytics={host.analytics}
        role="host"
      />,
    );
    expect(host.sent.filter((e) => e.name === 'room_created')).toHaveLength(1);

    const guest = captureAnalytics();
    render(
      <Harness
        view={baseView({ role: 'guest' })}
        lock={fakeWakeLock().lock}
        analytics={guest.analytics}
        role="guest"
      />,
    );
    expect(guest.sent.map((e) => e.name)).toContain('room_joined');
  });

  it('reports the gate opening and the first guess, each once', () => {
    const { analytics, sent } = captureAnalytics();
    const lock = fakeWakeLock().lock;
    const { rerender } = render(
      <Harness view={baseView({ phase: 'gate' })} lock={lock} analytics={analytics} role="host" />,
    );
    rerender(
      <Harness
        view={baseView({ phase: 'playing', gateOpen: true })}
        lock={lock}
        analytics={analytics}
        role="host"
      />,
    );
    rerender(
      <Harness
        view={baseView({ phase: 'playing', gateOpen: true, guesses: ['0123'] })}
        lock={lock}
        analytics={analytics}
        role="host"
      />,
    );
    rerender(
      <Harness
        view={baseView({ phase: 'playing', gateOpen: true, guesses: ['0123', '4567'] })}
        lock={lock}
        analytics={analytics}
        role="host"
      />,
    );
    expect(sent.filter((e) => e.name === 'play_gate_open')).toHaveLength(1);
    expect(sent.filter((e) => e.name === 'pvp_first_guess')).toHaveLength(1);
  });

  it('reports the finish with the result from the player’s point of view and their guess count', () => {
    const { analytics, sent } = captureAnalytics();
    const final = baseView({
      phase: 'final',
      gateOpen: true,
      seat: 0,
      guesses: ['0123', '4567', '8901'], // seat 0 made guesses 0 and 2
      verdict: {
        kind: 'final',
        result: 'seat0',
        reason: 'first-hit',
        faults: [],
        verifiedSecrets: ['1964', '4271'],
      },
    });
    render(<Harness view={final} lock={fakeWakeLock().lock} analytics={analytics} role="host" />);
    const finished = sent.find((e) => e.name === 'pvp_finished');
    expect(finished).toMatchObject({ name: 'pvp_finished', result: 'win', guesses: 2 });
  });

  it('reports a loss and a draw from the right point of view', () => {
    for (const [seat, result, expected] of [
      [1, 'seat0', 'loss'],
      [0, 'draw', 'draw'],
    ] as const) {
      const { analytics, sent } = captureAnalytics();
      const view = baseView({
        phase: 'final',
        gateOpen: true,
        seat,
        guesses: ['0123'],
        verdict: {
          kind: 'final',
          result,
          reason: 'cap',
          faults: [],
          verifiedSecrets: ['1964', '4271'],
        },
      });
      render(
        <Harness
          view={view}
          lock={fakeWakeLock().lock}
          analytics={analytics}
          role={seat === 0 ? 'host' : 'guest'}
        />,
      );
      expect(sent.find((e) => e.name === 'pvp_finished')).toMatchObject({ result: expected });
    }
  });

  it('reports a transaction error once per error code', () => {
    const { analytics, sent } = captureAnalytics();
    const lock = fakeWakeLock().lock;
    const errored = baseView({
      phase: 'gate',
      error: { code: 'commit-failed', message: 'x', retryable: true },
    });
    const { rerender } = render(
      <Harness view={errored} lock={lock} analytics={analytics} role="host" />,
    );
    rerender(
      <Harness
        view={{ ...errored, relay: 'down' }}
        lock={lock}
        analytics={analytics}
        role="host"
      />,
    );
    expect(sent.filter((e) => e.name === 'tx_error')).toHaveLength(1);
    expect(sent.find((e) => e.name === 'tx_error')).toMatchObject({ kind: 'commit-failed' });
  });

  it('does nothing without a view', () => {
    const { analytics, sent } = captureAnalytics();
    render(
      <Harness view={undefined} lock={fakeWakeLock().lock} analytics={analytics} role="host" />,
    );
    expect(sent).toEqual([]);
  });
});
