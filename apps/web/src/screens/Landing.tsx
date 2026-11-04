import { Button } from '../ui/Button.js';
import { Shell } from '../ui/Shell.js';

/** Where Accident lives inside Zend, for anyone who opens the site directly. */
export const ZEND_APP_URL = 'https://app.usezend.app/apps/accident';

/**
 * The landing page outside Zend. It matches the ZApp's own start screen: playing friends,
 * tournaments and the leaderboard all happen in Zend, so this points there.
 */
export function Landing({ onPractice, onHow }: { onPractice: () => void; onHow: () => void }) {
  return (
    <Shell title="Accident">
      <div className="flex flex-1 flex-col justify-center gap-4 pb-6">
        <p className="text-lg font-bold">Guess the code before your friend does.</p>
        <p>Play friends, join tournaments and climb the leaderboard in Zend.</p>
        <a
          href={ZEND_APP_URL}
          className="block min-h-12 w-full rounded-xl bg-ink px-5 py-3 text-center text-base font-bold text-paper active:bg-ink-soft"
        >
          Open in Zend
        </a>
        <Button tone="plain" onClick={onPractice}>
          Practice against the computer
        </Button>
        <Button tone="plain" onClick={onHow}>
          How to play
        </Button>
      </div>
    </Shell>
  );
}
