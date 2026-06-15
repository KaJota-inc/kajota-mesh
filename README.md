# Kajota Mesh

> On-chain co-sell commission split for the Kajota social-commerce marketplace.

**Hackathon submissions:** Mantle Turing Test Phase 2 (Jun 15, 2026, combined with Coach Agent v2) · AWS Activate Web3.

**Sister project:** [Kajota Coach Agent v2](https://github.com/KaJota-inc/kajota-coach) — multi-turn conversational agent that drafts co-sell listings. Mesh enforces those listings' commission terms on-chain.

---

## 🚀 Mantle Turing Test 2026 — submission

| | |
|---|---|
| **Track** | Mantle Turing Test Phase 2 |
| **Submission combined with** | [Kajota Coach Agent v2](https://github.com/KaJota-inc/kajota-coach) |
| **Repo (this one)** | <https://github.com/KaJota-inc/kajota-mesh> |
| **Network deployed** | Ethereum Sepolia (chainId 11155111) — see addresses below |
| **License** | MIT |

### Deployed contract addresses (Ethereum Sepolia)

| Contract | Address | Verify |
|---|---|---|
| `CosellRegistry` | [`0xfce6bd68d8d6f858d447f537d206c1e354b44315`](https://sepolia.etherscan.io/address/0xfce6bd68d8d6f858d447f537d206c1e354b44315) | Etherscan |
| `CosellEscrow` | [`0x599869cef2e4c52e2c9074caaf8f9fb0cb191776`](https://sepolia.etherscan.io/address/0x599869cef2e4c52e2c9074caaf8f9fb0cb191776) | Etherscan |
| USDC (Circle dev) | [`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`](https://sepolia.etherscan.io/address/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238) | Etherscan |

Deployed 2026-05-28 from `0xe10cff27c99074cd44c64bed1b000226442524a4`. Full deployment record at [`packages/contracts/deployments/11155111.json`](packages/contracts/deployments/11155111.json).

### Why Ethereum Sepolia (and not Mantle Sepolia)

The Phase 2 track judges the combined Coach + Mesh story end-to-end. The Coach agent v2 is the primary on-chain caller; Mesh is the settlement layer it mints into. Both repos use the same Sepolia testnet so the live demo runs through one chain, not two. The contracts are EVM-equivalent — porting to Mantle Sepolia is a single `pnpm --filter @kajota-mesh/contracts deploy:mantle-sepolia` away (see [`packages/contracts/scripts/deploy.ts`](packages/contracts/scripts/deploy.ts)).

### Judge-facing demo path

For a 5-minute review without setting up the full stack:

1. **Inspect the registry** — open the [Registry contract on Etherscan](https://sepolia.etherscan.io/address/0xfce6bd68d8d6f858d447f537d206c1e354b44315) → Contract → Read. Call `getListing(listingId)` with any indexed `ListingRegistered` event's listingId.
2. **Inspect the escrow** — same pattern on the [Escrow contract](https://sepolia.etherscan.io/address/0x599869cef2e4c52e2c9074caaf8f9fb0cb191776). `getEscrow(listingId)` returns the funded amount + status.
3. **Watch a live flow** — events from both contracts surface in the [Coach Agent v2 demo video] (link in the kajota-coach repo). The agent drafts a listing → mints into Registry → buyer deposits into Escrow → ship event releases the split.

### Test the contracts yourself

```bash
pnpm install
pnpm --filter @kajota-mesh/contracts test
```

All three contracts (`CosellRegistry`, `CosellEscrow`, `CosellShipmentVerifier`) ship with unit tests. The shipment verifier integrates a Chainlink Functions consumer that calls back into the escrow once an off-chain ship event lands.

---

## What problem this solves

Kajota's existing `CosellProduct` flow records the commission split between a wholesaler and a co-seller (micro-distributor) as a Mongo document. Payouts happen via off-chain bookkeeping + a Spring Boot cron job. That setup requires the co-seller to trust:

1. The wholesaler won't change the split percentage retroactively.
2. Kajota's accounting will report the right cumulative volume.
3. The payout cron actually runs and pays.

Mesh removes (1) and (3) by moving the trust-critical primitives on-chain:

- **`CosellRegistry`** — stores `{productId, wholesaler, coseller, commissionBps, currency}` immutably (deactivate-only, no edit).
- **`CosellEscrow`** — receives USDC, auto-splits at the moment of release, no human in the loop.
- **`CosellShipmentVerifier`** — Chainlink Functions consumer that verifies an off-chain ship event and triggers the escrow release.

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
│              CosellRegistry (Ethereum Sepolia)                    │
│                                                                   │
│   register(productId, wholesaler, coseller, bps, currency)       │
│   → emits ListingRegistered                                       │
│   → listingId = keccak256(productId, wholesaler, coseller)        │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  ▼  (referenced by listingId)
┌──────────────────────────────────────────────────────────────────┐
│              CosellEscrow (Ethereum Sepolia)                      │
│                                                                   │
│   deposit(listingId) ← buyer sends USDC                          │
│   release(listingId) ← CosellShipmentVerifier confirms ship event │
│     ↓                                                             │
│   coseller wallet gets commissionBps share                       │
│   wholesaler wallet gets remainder                                │
└─────────────────────────────────┬────────────────────────────────┘
                                  ▲
                                  │  (verifies off-chain ship event)
┌──────────────────────────────────────────────────────────────────┐
│         CosellShipmentVerifier (Ethereum Sepolia)                 │
│         Chainlink Functions consumer                              │
└──────────────────────────────────────────────────────────────────┘
```

## Repo layout

```
kajota-mesh/
├── packages/
│   ├── contracts/             Hardhat 3 (TS + viem). Solidity 0.8.24, EVM Cancun.
│   │   ├── contracts/
│   │   │   ├── CosellRegistry.sol           ← deployed
│   │   │   ├── CosellEscrow.sol             ← deployed
│   │   │   └── CosellShipmentVerifier.sol   ← Chainlink Functions consumer
│   │   ├── test/                            unit tests for all three
│   │   ├── scripts/deploy.ts                deploys all three + writes deployments/<chainId>.json
│   │   ├── deployments/11155111.json        Ethereum Sepolia (live)
│   │   └── hardhat.config.ts
│   └── attestation/           Off-chain ship-event attestation server
├── pnpm-workspace.yaml
└── package.json
```

Mirrors [`kajota-concierge`](https://github.com/KaJota-inc/kajota-concierge) (also Hardhat 3 + viem) so the two sibling repos share toolchain and conventions.

## Running locally

```bash
pnpm install
pnpm test                 # runs Hardhat tests on the in-process EDR chain
pnpm --filter @kajota-mesh/contracts compile
pnpm --filter @kajota-mesh/contracts test
```

## Status

- [x] Repo scaffold, Hardhat 3 + viem + OpenZeppelin 5.1
- [x] `CosellRegistry.sol` (register / deactivate / read / split-math) + tests
- [x] `CosellEscrow.sol` (USDC deposit + release with auto-split) + tests
- [x] `CosellShipmentVerifier.sol` (Chainlink Functions consumer) + tests
- [x] Deployed to Ethereum Sepolia + records pinned at [`deployments/11155111.json`](packages/contracts/deployments/11155111.json)
- [x] Coach Agent v2 `publishListing` tool wired to mint on-chain (see [kajota-coach](https://github.com/KaJota-inc/kajota-coach))
- [ ] Cross-deploy to Mantle Sepolia for breadth points
- [ ] Demo video URL (added on submission day)

## License

MIT — see [`LICENSE`](LICENSE).
