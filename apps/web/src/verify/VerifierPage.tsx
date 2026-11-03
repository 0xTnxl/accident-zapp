import type { Chain, Fault, HashCheck, Verdict, VerifyResult } from '@accident/protocol';
import { verifyGame } from '@accident/protocol';
import { useState } from 'react';
import { CheckIcon } from '../ui/Icons.js';
import { Button } from '../ui/Button.js';
import { Shell } from '../ui/Shell.js';
import { faultText } from '../friend/faults.js';
import { createVerifierChain, explorerUrl } from './backend.js';

interface VerifierPageProps {
  onBack: () => void;
  /**
   * A seam for tests: supplies the chain used to fetch Memos. Defaults to the real SolanaChain,
   * built lazily so @solana/web3.js stays in this split chunk and never runs during a unit test.
   */
  createChain?: () => Chain;
}

type State =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; result: VerifyResult };

const SEAT_LABEL = ['Seat 0 (host)', 'Seat 1 (guest)'] as const;

export function VerifierPage({ onBack, createChain = createVerifierChain }: VerifierPageProps) {
  const [sig0, setSig0] = useState('');
  const [sig1, setSig1] = useState('');
  const [fileName, setFileName] = useState<string | undefined>();
  const [transcriptFile, setTranscriptFile] = useState<File | undefined>();
  const [state, setState] = useState<State>({ phase: 'idle' });

  async function onSubmit(): Promise<void> {
    if (!transcriptFile) {
      setState({ phase: 'error', message: 'Choose the transcript file you saved from the game.' });
      return;
    }
    if (sig0.trim() === '' || sig1.trim() === '') {
      setState({ phase: 'error', message: 'Paste both reveal transaction signatures.' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await transcriptFile.text());
    } catch {
      setState({
        phase: 'error',
        message: 'That file is not valid JSON. Use the record you saved from the game.',
      });
      return;
    }

    setState({ phase: 'checking' });
    try {
      const result = await verifyGame(
        { transcript: parsed, revealSigs: [sig0.trim(), sig1.trim()] },
        { chain: createChain() },
      );
      setState({ phase: 'done', result });
    } catch {
      setState({
        phase: 'error',
        message: 'Could not reach the chain to check this game. Try again in a moment.',
      });
    }
  }

  return (
    <Shell title="Verify a game" onBack={onBack}>
      <div className="flex-1 space-y-4 overflow-y-auto pt-1 pb-3">
        <p className="text-sm text-ink-soft">
          Anyone can check a finished game. Paste the two reveal transaction signatures and the
          saved record, and this reads the chain to confirm every answer was honest.
        </p>

        <div className="space-y-3">
          <label className="block text-sm">
            <span className="font-semibold">Seat 0 (host) reveal signature</span>
            <input
              type="text"
              value={sig0}
              onChange={(e) => setSig0(e.target.value)}
              placeholder="The host’s reveal transaction"
              className="mt-1 w-full rounded-xl border-2 border-rule bg-paper p-2 font-mono text-sm"
              data-testid="sig0"
            />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Seat 1 (guest) reveal signature</span>
            <input
              type="text"
              value={sig1}
              onChange={(e) => setSig1(e.target.value)}
              placeholder="The guest’s reveal transaction"
              className="mt-1 w-full rounded-xl border-2 border-rule bg-paper p-2 font-mono text-sm"
              data-testid="sig1"
            />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Saved record</span>
            <input
              type="file"
              accept="application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                setTranscriptFile(file);
                setFileName(file?.name);
              }}
              className="mt-1 block w-full text-sm"
              data-testid="transcript"
            />
            {fileName ? <span className="mt-1 block text-ink-soft">{fileName}</span> : null}
          </label>
          <Button
            onClick={() => void onSubmit()}
            disabled={state.phase === 'checking'}
            data-testid="check"
          >
            {state.phase === 'checking' ? 'Checking the chain…' : 'Check this game'}
          </Button>
        </div>

        {state.phase === 'error' ? (
          <div
            role="alert"
            className="rounded-xl border-2 border-dead bg-dead/5 p-3 text-sm"
            data-testid="error"
          >
            <p className="font-bold text-dead">That did not work</p>
            <p className="mt-1">{state.message}</p>
          </div>
        ) : null}

        {state.phase === 'done' ? <ResultView result={state.result} /> : null}
      </div>
    </Shell>
  );
}

function ResultView({ result }: { result: VerifyResult }) {
  if (!result.ok) {
    return (
      <div
        role="alert"
        className="rounded-xl border-2 border-dead bg-dead/5 p-3 text-sm"
        data-testid="error"
      >
        <p className="font-bold text-dead">That did not work</p>
        <p className="mt-1">{result.error}</p>
      </div>
    );
  }

  const { verdict } = result;

  return (
    <div className="space-y-4" data-testid="verdict">
      <Headline verdict={verdict} />
      <Secrets verdict={verdict} />
      <Faults faults={verdict.faults} />
      <Hashes hashCheck={result.hashCheck} />
      <PublicRecords commitSigs={result.commitSigs} revealSigs={result.revealSigs} />
      <Ignored ignored={result.ignored} />
    </div>
  );
}

/** Plain words for the outcome. There is no "you" on the verifier, so the copy is seat-neutral. */
function headlineText(verdict: Verdict): string {
  if (verdict.kind === 'abandoned') return 'No result: neither player revealed';
  if (verdict.kind === 'pending') return 'No result yet: a reveal is still missing';
  const winner =
    verdict.result === 'seat0'
      ? 'Seat 0 (host) wins'
      : verdict.result === 'seat1'
        ? 'Seat 1 (guest) wins'
        : 'Draw';
  return `${winner}: ${reasonText(verdict)}`;
}

function reasonText(verdict: Verdict & { kind: 'final' }): string {
  switch (verdict.reason) {
    case 'fault':
      return 'a lie was proved';
    case 'both-at-fault':
      return 'both players were at fault';
    case 'first-hit':
      return 'first to find the other’s number';
    case 'equal-round':
      return 'both found it in the same round';
    case 'cap':
      return 'nobody found the other’s number';
  }
}

function Headline({ verdict }: { verdict: Verdict }) {
  const tone = verdict.kind === 'final' && verdict.result !== 'draw' ? 'text-ink' : 'text-ink-soft';
  return (
    <h2 className={`text-center text-2xl font-black ${tone}`} data-testid="headline">
      {headlineText(verdict)}
    </h2>
  );
}

function Secrets({ verdict }: { verdict: Verdict }) {
  const secrets =
    verdict.kind === 'final' ? verdict.verifiedSecrets : ([undefined, undefined] as const);
  return (
    <section className="grid grid-cols-2 gap-2 text-center" aria-label="Secrets">
      {([0, 1] as const).map((seat) => {
        const secret = secrets[seat];
        return (
          <div key={seat} className="rounded-xl border-2 border-rule p-2">
            <p className="text-xs text-ink-soft">{SEAT_LABEL[seat]}</p>
            <p className="font-mono text-2xl font-bold">{secret ?? '????'}</p>
            <p
              className={`flex items-center justify-center gap-1 text-xs font-semibold ${secret ? 'text-good' : 'text-dead'}`}
            >
              {secret ? <CheckIcon className="size-3.5" /> : null}
              {secret ? 'Verified against the lock-in' : 'Not verified'}
            </p>
          </div>
        );
      })}
    </section>
  );
}

/** Seat-neutral fault copy: prefix the seat, then reuse the shared, evidence-aware faultText. */
function faultLine(fault: Fault): string {
  return `${SEAT_LABEL[fault.seat]}: ${faultText(fault)}`;
}

function Faults({ faults }: { faults: readonly Fault[] }) {
  if (faults.length === 0) {
    return (
      <p className="text-center text-sm text-good">Every answer matched the revealed secrets.</p>
    );
  }
  return (
    <section
      aria-label="What the record shows"
      className="rounded-xl border-2 border-dead bg-dead/5 p-3 text-sm"
      data-testid="faults"
    >
      <h3 className="font-bold text-dead">What the record shows</h3>
      <ul className="mt-1 list-disc pl-5">
        {faults.map((fault, i) => (
          <li key={i}>{faultLine(fault)}</li>
        ))}
      </ul>
    </section>
  );
}

function Hashes({ hashCheck }: { hashCheck: readonly [HashCheck, HashCheck] }) {
  return (
    <section aria-label="Transcript anchor">
      <h3 className="text-xs font-bold tracking-widest text-ink-soft uppercase">
        Transcript anchor
      </h3>
      <ul className="mt-1 space-y-1 text-sm">
        {([0, 1] as const).map((seat) => {
          const check = hashCheck[seat];
          const text = !check.present
            ? 'no anchor (older reveal format)'
            : check.matches
              ? 'anchor matched'
              : 'anchor does not match: a transcript dispute, not a fault';
          return (
            <li key={seat} className="flex items-center justify-between gap-2">
              <span>{SEAT_LABEL[seat]}</span>
              <span className={check.present && !check.matches ? 'text-dead' : 'text-ink-soft'}>
                {text}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PublicRecords({
  commitSigs,
  revealSigs,
}: {
  commitSigs: readonly [string | undefined, string | undefined];
  revealSigs: readonly [string | undefined, string | undefined];
}) {
  const links: Array<[string, string | undefined]> = [
    ['Seat 0 (host) lock-in', commitSigs[0]],
    ['Seat 0 (host) reveal', revealSigs[0]],
    ['Seat 1 (guest) lock-in', commitSigs[1]],
    ['Seat 1 (guest) reveal', revealSigs[1]],
  ];
  return (
    <section aria-label="Public records">
      <h3 className="text-xs font-bold tracking-widest text-ink-soft uppercase">Public records</h3>
      <ul className="mt-1 space-y-1">
        {links.map(([label, sig]) => (
          <li key={label} className="flex items-center justify-between gap-2 text-sm">
            <span>{label}</span>
            {sig ? (
              <a
                href={explorerUrl(sig)}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono underline"
              >
                {sig.slice(0, 6)}…{sig.slice(-4)}
              </a>
            ) : (
              <span className="font-mono text-ink-soft">none</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Ignored({ ignored }: { ignored: readonly string[] }) {
  if (ignored.length === 0) return null;
  return (
    <section
      aria-label="Ignored messages"
      className="rounded-xl border-2 border-rule p-3 text-sm"
      data-testid="ignored"
    >
      <h3 className="font-bold">
        {ignored.length} message{ignored.length === 1 ? '' : 's'} ignored
      </h3>
      <ul className="mt-1 list-disc pl-5 text-ink-soft">
        {ignored.map((reason, i) => (
          <li key={i}>{reason}</li>
        ))}
      </ul>
    </section>
  );
}
