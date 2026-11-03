import { generateRoomCode, isValidRoom } from '@accident/protocol';
import { useState } from 'react';
import { Button } from '../ui/Button.js';
import { Shell } from '../ui/Shell.js';

interface LobbyProps {
  onBack: () => void;
  onCreate: (code: string) => void;
  onJoin: (code: string) => void;
  /** Shown when friend mode is running against a pretend chain. */
  simulation: boolean;
}

/** Normalises what a person types into a room code: trims, upper-cases and drops stray spaces. */
export function cleanCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function Lobby({ onBack, onCreate, onJoin, simulation }: LobbyProps) {
  const [code, setCode] = useState('');
  const cleaned = cleanCode(code);
  const valid = isValidRoom(cleaned);
  const showError = cleaned.length >= 6 && !valid;

  return (
    <Shell title="Play a friend" onBack={onBack}>
      <div className="flex flex-1 flex-col gap-6 pt-2">
        {simulation ? <SimulationBanner /> : null}

        <section className="flex flex-col gap-2">
          <h2 className="font-bold">Start a game</h2>
          <p className="text-sm text-ink-soft">
            You get a code and a link to send. Your secret is locked in with a public record before
            the first guess.
          </p>
          <Button onClick={() => onCreate(generateRoomCode())}>Create a room</Button>
        </section>

        <div className="flex items-center gap-3 text-sm text-ink-soft" aria-hidden="true">
          <span className="h-px flex-1 bg-rule" />
          or
          <span className="h-px flex-1 bg-rule" />
        </div>

        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onJoin(cleaned);
          }}
        >
          <h2 className="font-bold">
            <label htmlFor="code">Join with a code</label>
          </h2>
          <input
            id="code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            maxLength={12}
            placeholder="ABC234"
            aria-invalid={showError}
            aria-describedby={showError ? 'code-error' : undefined}
            className="min-h-14 rounded-xl border-2 border-ink bg-paper px-4 text-center font-mono text-2xl font-bold tracking-[0.3em] uppercase placeholder:text-rule"
          />
          {showError ? (
            <p id="code-error" role="alert" className="text-sm text-dead">
              A room code is six letters and numbers. It never has the letters I or O, or the digits
              0 or 1.
            </p>
          ) : null}
          <Button type="submit" tone="plain" disabled={!valid}>
            Join
          </Button>
        </form>
      </div>
    </Shell>
  );
}

export function SimulationBanner() {
  return (
    <p
      role="note"
      className="rounded-xl border-2 border-dashed border-dead bg-dead/5 p-3 text-sm text-dead"
      data-testid="simulation-banner"
    >
      <strong>Simulation.</strong> This build pretends to be Solana and the relay, and works only
      between tabs of this browser. Nothing is public and nothing is recorded on-chain.
    </p>
  );
}
