import type { ReactNode } from 'react';
import { Suspense, lazy, useEffect, useState } from 'react';
import { init as initZend } from './zapp/appkit.js';
import { analytics } from './lib/analytics.js';
import { useRoute } from './lib/useRoute.js';
import { Landing } from './screens/Landing.js';
import { How } from './screens/How.js';
import { Practice } from './screens/Practice.js';
import { Stats } from './screens/Stats.js';
import { Button } from './ui/Button.js';
import { Shell } from './ui/Shell.js';

// Friend mode pulls in the Solana client, the relay client and the QR encoder. Loading them only
// when a player opens it keeps the first screen, and the offline computer game, small and quick.
const FriendRoot = lazy(() =>
  import('./friend/FriendRoot.js').then((m) => ({ default: m.FriendRoot })),
);

// The Verifier reads the chain through the Solana client too, so it is lazy-loaded for the same
// reason: to keep @solana/web3.js out of the always-loaded entry.
const VerifierPage = lazy(() =>
  import('./verify/VerifierPage.js').then((m) => ({ default: m.VerifierPage })),
);

// Inside Zend (mobile WebView or the app.usezend.app frame) Accident runs as a ZApp.
const ZAppRoot = lazy(() => import('./zapp/ZAppRoot.js').then((m) => ({ default: m.ZAppRoot })));
const zend = initZend();

function Loading() {
  return (
    <Shell title="Accident">
      <p className="py-6 text-ink-soft" role="status">
        Loading…
      </p>
    </Shell>
  );
}

export function App(): ReactNode {
  const [route, go] = useRoute();
  // Inside Zend (mobile app or app.usezend.app) the ZApp is the home screen. Practice and How to
  // play step out of it, and their back buttons step back in.
  const embedded = zend.environment !== 'external';
  const [inZApp, setInZApp] = useState(embedded);
  useEffect(() => analytics().send({ name: 'app_open' }), []);
  const home = (): void => (embedded ? setInZApp(true) : go({ name: 'home' }));
  if (inZApp) {
    return (
      <Suspense fallback={<Loading />}>
        <ZAppRoot
          zend={zend}
          onPractice={() => {
            setInZApp(false);
            go({ name: 'practice' });
          }}
          onHow={() => {
            setInZApp(false);
            go({ name: 'how' });
          }}
        />
      </Suspense>
    );
  }

  switch (route.name) {
    case 'home':
      return <Landing onPractice={() => go({ name: 'practice' })} onHow={() => go({ name: 'how' })} />;
    case 'how':
      return <How onBack={home} onPlay={() => go({ name: 'practice' })} />;
    case 'stats':
      return <Stats onBack={home} />;
    case 'practice':
      return <Practice onBack={home} />;
    case 'friend':
    case 'room':
      return (
        <Suspense fallback={<Loading />}>
          <FriendRoot route={route} go={go} />
        </Suspense>
      );
    case 'verify':
      return (
        <Suspense fallback={<Loading />}>
          <VerifierPage onBack={home} />
        </Suspense>
      );
    case 'notfound':
      return (
        <Shell title="Not found" onBack={home}>
          <div className="flex flex-1 flex-col justify-center gap-4">
            <p>
              That link does not look right. Room codes are six letters and numbers, like ABC234.
            </p>
            <Button onClick={home}>Home</Button>
          </div>
        </Shell>
      );
  }
}
