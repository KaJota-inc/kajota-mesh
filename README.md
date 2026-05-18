# Kajota Mesh

> On-chain co-sell commission split for the Kajota social-commerce marketplace.

**Hackathon submissions:** Mantle Turing Test Phase 2 (Jun 15, combined with Coach Agent v2) · AWS Activate Web3.

**Sister project:** [Kajota Coach Agent v2](https://github.com/KaJota-inc/kajota-coach) — multi-turn conversational agent that drafts co-sell listings. Mesh enforces those listings' commission terms on-chain.

---

## What problem this solves

Kajota's existing `CosellProduct` flow records the commission split between a wholesaler and a co-seller (micro-distributor) as a Mongo document. Payouts happen via off-chain bookkeeping + a Spring Boot cron job. That setup requires the co-seller to trust:

1. The wholesaler won't change the split percentage retroactively.
2. Kajota's accounting will report the right cumulative volume.
3. The payout cron actually runs and pays.

Mesh removes (1) and (3) by moving the trust-critical primitives on-chain:

- `CosellRegistry` — stores `{productId, wholesaler, coseller, commissionBps, currency}` immutably (deactivate-only, no edit).
- `CosellEscrow` *(coming next)* — receives USDC, auto-splits at the moment of release, no human in the loop.

The Kajota app continues to be the merchandising layer; Mesh is the settlement layer.

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│                    Kajota Coach Agent v2                          │
│  (multi-turn agent — see github.com/KaJota-inc/kajota-coach)      │
│                                                                   │
│     drafts listing → user confirms → publishListing tool          │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  ▼  (mints on-chain via wholesaler key)
┌──────────────────────────────────────────────────────────────────┐
│                   CosellRegistry (Base Sepolia)                   │
│                                                                   │
│   register(productId, wholesaler, coseller, bps, currency)       │
│   → emits ListingRegistered                                       │
│   → listingId = keccak256(productId, wholesaler, coseller)        │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  ▼  (referenced by listingId)
┌──────────────────────────────────────────────────────────────────┐
│                  CosellEscrow (Base Sepolia)  ⏳ next             │
│                                                                   │
│   deposit(listingId) ← buyer sends USDC                          │
│   release(listingId) ← Chainlink Functions confirms ship event    │
│     ↓                                                             │
│   coseller wallet gets commissionBps share                       │
│   wholesaler wallet gets remainder                                │
└──────────────────────────────────────────────────────────────────┘
```

## Repo layout

```
kajota-mesh/
├── packages/
│   └── contracts/             Hardhat 3 (TS + viem). Solidity 0.8.24, EVM Cancun.
│       ├── contracts/
│       │   ├── CosellRegistry.sol   ← live
│       │   └── CosellEscrow.sol     ← next
│       ├── test/
│       │   └── CosellRegistry.test.ts
│       └── hardhat.config.ts
├── apps/
│   └── docs/                  Whitepaper + architecture (not yet authored)
├── pnpm-workspace.yaml
└── package.json
```

Mirrors [`kajota-concierge`](https://github.com/KaJota-inc/kajota-concierge) (also Hardhat 3 + viem) so the two sibling repos share toolchain and conventions.

## Running locally

```bash
pnpm install
pnpm test                 # runs Hardhat tests on the in-process EDR chain
pnpm --filter @kajota-mesh/contracts compile
```

## Status

- [x] Repo scaffold, Hardhat 3 + viem + OpenZeppelin 5.1
- [x] `CosellRegistry.sol` (register / deactivate / read / split-math)
- [x] 9 unit tests for `CosellRegistry`
- [ ] `CosellEscrow.sol` (USDC deposit + release with auto-split)
- [ ] Deploy to Base Sepolia + verify on Basescan
- [ ] Chainlink Functions attestation script (off-chain ship-event → release)
- [ ] Coach Agent v2 `publishListing` tool wired to mint on-chain
- [ ] Demo video + Mantle Turing Test Phase 2 submission

## License

MIT — see [`LICENSE`](LICENSE).
