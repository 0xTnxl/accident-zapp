import type { Identity } from '@accident/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Route } from '../lib/route.js';
import { Button } from '../ui/Button.js';
import { Shell } from '../ui/Shell.js';
import type { Backend, BackendKind } from './backend.js';
import { createBackend } from './backend.js';
import type { Choice, SetupState } from './controller.js';
import { Analytics, noopAnalytics } from './analytics.js';
import { readEnv, readTurnMs } from './env.js';
import { Lobby } from './Lobby.js';
import { controllerFor, leaveRoom } from './registry.js';
import { Room } from './Room.js';
import { loadOrCreateIdentity } from './vault.js';
import { useGameEffects } from './useGameEffects.js';
import { WakeLock, browserWakeLockEnv } from './wakeLock.js';
import type { SessionView } from '@accident/protocol';

interface FriendRootProps {
  route: Route;
  go: (route: Route, options?: { replace?: boolean }) => void;
}

/** One backend per page load. Built lazily so a missing configuration is reported, not thrown. */
let cached: { backend: Backend } | { error: string } | undefined;

/** One analytics object and one wake lock for the page. Disabled analytics in the simulation build. */
let shared: { analytics: Analytics; wakeLock: WakeLock } | undefined;
function sharedServices(kind: BackendKind): { analytics: Analytics; wakeLock: WakeLock } {
  shared ??= {
    analytics: kind === 'sim' ? noopAnalytics : new Analytics(),
    wakeLock: new WakeLock(browserWakeLockEnv()),
  };
  return shared;
}

function backend(): { backend: Backend } | { error: string } {
  if (!cached) {
    try {
      cached = { backend: createBackend(readEnv()) };
    } catch (e) {
      cached = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return cached;
}

/** Test hook: forget the cached backend. */
export function resetBackend(): void {
  cached = undefined;
  shared = undefined;
}

export function FriendRoot({ route, go }: FriendRootProps) {
  const home = useCallback(() => go({ name: 'home' }), [go]);
  const built = backend();

  if ('error' in built) {
    return (
      <Shell title="Play a friend" onBack={home}>
        <div className="flex flex-1 flex-col justify-center gap-4">
          <h2 className="text-xl font-bold">Friend games are not switched on here</h2>
          <p>
            This copy of the app has not been connected to the game relay yet, so two phones cannot
            find each other. You can still play the computer.
          </p>
          <p className="font-mono text-xs text-ink-soft" data-testid="config-error">
            {built.error}
          </p>
          <Button onClick={() => go({ name: 'practice' })}>Play the computer</Button>
        </div>
      </Shell>
    );
  }

  if (route.name === 'friend') {
    return (
      <Lobby
        onBack={home}
        simulation={built.backend.kind === 'sim'}
        onCreate={(code) => go({ name: 'room', code, role: 'host', hostKey: undefined })}
        onJoin={(code) => go({ name: 'room', code, role: 'guest', hostKey: undefined })}
      />
    );
  }

  if (route.name !== 'room') return null;
  return <ActiveRoom route={route} backend={built.backend} go={go} />;
}

export function ActiveRoom({
  route,
  backend: be,
  go,
  vaultKey,
  leave,
  rematch,
}: {
  route: Extract<Route, { name: 'room' }>;
  backend: Backend;
  go: FriendRootProps['go'];
  /** Keeps this game's key separate in storage (ZApp mode: one key per interaction). */
  vaultKey?: string | undefined;
  /** ZApp mode: leaving closes the app and rematch starts a new challenge, instead of routing. */
  leave?: (() => void) | undefined;
  rematch?: (() => void) | undefined;
}) {
  // Two tabs of one browser share storage. In the simulation build only, `?as=name` makes a tab a
  // separate player so a game can be played against yourself. A real device ignores it.
  const player = useMemo(
    () =>
      vaultKey ??
      (be.kind === 'sim'
        ? (new URLSearchParams(window.location.search).get('as') ?? undefined)
        : undefined),
    [be.kind, vaultKey],
  );
  const identity: Identity = useMemo(() => loadOrCreateIdentity(localStorage, player), [player]);
  // A guest's link carries the host's key; the host already knows its own.
  const hostKey = route.role === 'host' ? identity.publicKey : route.hostKey;

  const controller = useMemo(
    () =>
      controllerFor({
        room: route.code,
        role: route.role,
        hostKey: route.role === 'host' ? undefined : hostKey,
        identity,
        backend: be,
        player,
        turnMs: readTurnMs(),
      }),
    [route.code, route.role, hostKey, identity, be, player],
  );

  const [view, setView] = useState<SessionView | undefined>(() => controller.view());
  const [setup, setSetup] = useState<SetupState>(() => controller.state());
  const [resuming, setResuming] = useState(controller.view() === undefined);

  const { analytics, wakeLock } = sharedServices(be.kind);
  useGameEffects(view, { wakeLock, analytics, role: route.role });

  useEffect(() => {
    const offView = controller.onView(setView);
    const offSetup = controller.onSetup(setSetup);
    setView(controller.view());
    setSetup(controller.state());
    let cancelled = false;
    if (controller.view() === undefined) {
      // A game saved on this device from before a refresh picks up where it left off.
      void controller.resume().then(() => {
        if (!cancelled) setResuming(false);
      });
    } else {
      setResuming(false);
    }
    return () => {
      cancelled = true;
      offView();
      offSetup();
    };
  }, [controller]);

  const onLeave = useCallback(() => {
    void leaveRoom(route.code).then(() => (leave ? leave() : go({ name: 'home' })));
  }, [go, route.code, leave]);

  const onRematch = useCallback(() => {
    void leaveRoom(route.code).then(() => (rematch ? rematch() : go({ name: 'friend' })));
  }, [go, route.code, rematch]);

  const onExport = useCallback(() => {
    const lines = controller.transcript();
    const current = controller.view();
    const file: Record<string, unknown> = {
      room: route.code,
      messages: lines.map((l) => JSON.parse(l) as unknown),
    };
    // Timestamps for a trustworthy finish time (design.md section 5.3), optional: an older export
    // or a game resumed from a save made before this field existed may not have them, in which
    // case anything reading this file falls back to the reveal Memos' on-chain block times.
    if (current?.gateOpenedAt !== undefined) file.gateOpenedAt = current.gateOpenedAt;
    if (current?.gameOverAt !== undefined) file.gameOverAt = current.gameOverAt;
    const blob = new Blob([JSON.stringify(file, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `accident-${route.code}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [controller, route.code]);

  return (
    <Room
      room={route.code}
      role={route.role}
      hostKey={identity.publicKey}
      backend={be}
      setup={setup}
      view={view}
      resuming={resuming}
      origin={window.location.origin}
      now={Date.now}
      onBegin={(choice: Choice) => void controller.begin(choice)}
      onGuess={(code) => void controller.guess(code).catch(() => undefined)}
      onClaimTimeout={() => void controller.claimTimeout().catch(() => undefined)}
      onRetry={() => void controller.retry()}
      onExport={onExport}
      onLeave={onLeave}
      onRematch={onRematch}
    />
  );
}
