# ACCIDENT project conventions

- Product: Accident (Bulls and Cows, "dead" and "injured"), two-player, Solana devnet only. Spec lives in `.kiro/specs/accident/`. Read `requirements.md` and `design.md` before changing behaviour.
- Scope rule: no custom Solana program, no escrow, no tokens, no mainnet. On-chain footprint is Memo transactions only.
- Game rules are canonical in `requirements.md` REQ-3 and PRD section 4. Change the spec first, then the code.
- `packages/engine` and `packages/protocol` are pure TypeScript with no DOM, network or RPC imports. Side effects go through the `Transport`, `Chain`, `Storage` and `Clock` interfaces.
- TypeScript strict. Pin dependency versions. Use `@solana/web3.js` v1 only inside the chain adapter and `tweetnacl` for relay signatures.
- Never commit secrets. `.env*` is git-ignored; `.env.example` lists variable names only.
- The commitment test vector (`525d7b2d31149cd7453b079bbaa25f6e170652683c478f5e06d19717f9ba7f15`) must pass in Node and in the browser.
- Be honest in copy and docs: timeouts are UI-only, solver-assisted play cannot be prevented, practice mode is not provably fair.
