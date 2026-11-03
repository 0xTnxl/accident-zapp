import { Button } from '../ui/Button.js';
import { Shell } from '../ui/Shell.js';

interface HomeProps {
  onPractice: () => void;
  onFriend: () => void;
  onHow: () => void;
  onStats: () => void;
  onVerify: () => void;
}

export function Home({ onPractice, onFriend, onHow, onStats, onVerify }: HomeProps) {
  return (
    <Shell title="Accident">
      <div className="flex flex-1 flex-col justify-center gap-6 pb-6">
        <div>
          <p className="font-mono text-6xl font-black tracking-[0.25em] text-ink">1964</p>
          <p className="mt-3 text-lg leading-snug text-ink">
            Guess your friend’s secret number before they guess yours. Each answer says how many
            digits are <strong className="text-dead">dead</strong> (right place) and{' '}
            <strong className="text-injured">injured</strong> (wrong place).
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Button onClick={onPractice}>Play the computer</Button>
          <Button tone="plain" onClick={onFriend}>
            Play a friend
          </Button>
        </div>

        <nav className="flex justify-center gap-6 text-base font-semibold">
          <button
            type="button"
            onClick={onHow}
            className="min-h-11 px-2 underline underline-offset-4"
          >
            How to play
          </button>
          <button
            type="button"
            onClick={onStats}
            className="min-h-11 px-2 underline underline-offset-4"
          >
            My stats
          </button>
          <button
            type="button"
            onClick={onVerify}
            className="min-h-11 px-2 underline underline-offset-4"
          >
            Verify a game
          </button>
        </nav>
      </div>
    </Shell>
  );
}
