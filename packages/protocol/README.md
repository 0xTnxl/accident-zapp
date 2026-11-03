# @accident/protocol

The fairness protocol for Accident, as pure TypeScript. It depends only on
`@accident/engine`, `tweetnacl`, `bs58` and standard WebCrypto, with no DOM, network or RPC code.
The chain and the relay plug in later through small interfaces. Spec: `.kiro/specs/accident/`.

## What is here

| Module          | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `commitment.ts` | `SHA-256("ACCIDENT_V1" \|\| room \|\| key \|\| secret \|\| salt)`           |
| `memo.ts`       | Commit and reveal Memo text, strict parsing, earliest-record-wins selection |
| `messages.ts`   | Ed25519-signed relay messages with a strict payload grammar                 |
| `transcript.ts` | Order-independent assembly of a signed game and its canonical SHA-256 hash  |
| `finalise.ts`   | Deterministic verdict with evidence for every fault                         |
| `session.ts`    | One player's whole game: log, play gate, auto-answer, reveal, verdict       |
| `ports.ts`      | `Transport`, `Chain`, `Storage`, `Clock` interfaces                         |
| `testing/`      | In-memory fakes with fault injection (drop, duplicate, reorder, slow chain) |

## Trust model in one paragraph

Nothing from the opponent or the relay is trusted. Every message is parsed strictly and its signature
checked before use. A transcript is rebuilt from signed messages only, so forged, replayed, foreign
or out-of-turn messages are dropped. The verdict depends on the signed transcript, the Memo records
(earliest one wins) and the revealed secrets, so both players reach the same result.

## Commitment test vector

Room `ABC234`, player key bytes 0 to 31, secret `1234`, salt bytes 32 to 63 must give
`525d7b2d31149cd7453b079bbaa25f6e170652683c478f5e06d19717f9ba7f15`. The test suite checks this and
cross-checks random inputs against Node's own crypto.

## Testing

```sh
pnpm --filter @accident/protocol test            # fast
pnpm --filter @accident/protocol test:coverage   # enforces 100% coverage
```

## Not here yet

The real `Chain` adapter (web3.js on devnet) and `Transport` adapter (relay). Both implement the small interfaces in `ports.ts` and are tested against the same fakes.
