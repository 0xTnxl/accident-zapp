import { Button } from '../ui/Button.js';
import { Chips } from '../ui/Board.js';
import { Shell } from '../ui/Shell.js';

export function How({ onBack, onPlay }: { onBack: () => void; onPlay: () => void }) {
  return (
    <Shell title="How to play" onBack={onBack}>
      <div className="flex-1 space-y-5 overflow-y-auto pb-4 text-base leading-relaxed">
        <section>
          <h2 className="font-bold">1. Pick a secret</h2>
          <p>
            Choose four <strong>different</strong> digits, like{' '}
            <span className="font-mono">1964</span>. A zero at the front is fine. Keep it to
            yourself.
          </p>
        </section>

        <section>
          <h2 className="font-bold">2. Take turns guessing</h2>
          <p>Try to find the other player’s number. After each guess you get two counts.</p>
          <ul className="mt-2 space-y-1">
            <li>
              <strong className="text-dead">Dead</strong>: a right digit in the right place.
            </li>
            <li>
              <strong className="text-injured">Injured</strong>: a right digit in the wrong place.
            </li>
          </ul>
        </section>

        <section className="rounded-xl border-2 border-dashed border-rule p-3">
          <h2 className="mb-2 text-xs font-bold tracking-widest text-ink-soft uppercase">
            Example
          </h2>
          <p>
            Secret <span className="font-mono font-bold">1964</span>, guess{' '}
            <span className="font-mono font-bold">2604</span>:
          </p>
          <div className="my-2 flex items-center gap-3">
            <span className="font-mono text-xl tracking-[0.3em]">2604</span>
            <Chips feedback={11} />
          </div>
          <p className="text-sm text-ink-soft">
            The <strong>4</strong> is in the right place (dead). The <strong>6</strong> is in the
            code but in the wrong place (injured). The 2 and 0 are not in the code at all.
          </p>
        </section>

        <section>
          <h2 className="font-bold">3. Win</h2>
          <p>
            Get <strong>4 dead</strong> first. If the player who went first gets there, the other
            player gets one last guess to equal it. At most 12 guesses each.
          </p>
        </section>

        <section>
          <h2 className="font-bold">Why a Solana record?</h2>
          <p>
            In a friend game you both lock in your secret with a hash on Solana before the first
            guess. That makes it provable later that nobody changed their number or lied about an
            answer. The computer game runs on your phone and is <strong>not</strong> provably fair.
          </p>
        </section>
      </div>
      <Button onClick={onPlay}>Play now</Button>
    </Shell>
  );
}
