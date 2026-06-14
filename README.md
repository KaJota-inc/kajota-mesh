# Kajota Mesh

> On-chain co-sell commission split for the Kajota social-commerce marketplace.

**Hackathon submissions:** ETHGlobal NY 2026 (Jun 12–14) · Mantle Turing Test Phase 2 (Jun 15, combined with Coach Agent v2) · AWS Activate Web3.

**Sister project:** [Kajota Coach Agent v2](https://github.com/KaJota-inc/kajota-coach) — multi-turn conversational agent that drafts co-sell listings. Mesh enforces those listings' commission terms on-chain.

---

## What problem this solves

Kajota's existing `CosellProduct` flow records the commission split between a wholesaler and a co-seller (micro-distributor) as a Mongo document. Payouts happen via off-chain bookkeeping + a Spring Boot cron job. That setup requires the co-seller to trust:

1. The wholesaler won't change the split percentage retroactively.
2. Kajota's accounting will report the right cumulative volume.
3. The payout cron actually runs and pays.

Mesh removes (1) and (3) by moving the trust-critical primitives on-chain:

- **`CosellRegistry`** — stores `{productId, wholesaler, coseller, commissionBps, currency}` immutably (deactivate-only, no edit).
- **`CosellEscrow`** — receives USDC, auto-splits at the moment of release, no human in the loop.
- **`CosellShipmentVerifier`** — Chainlink Functions consumer that confirms shipment via a Kajota attestation, then calls `escrow.release()`.
- **`KajotaEscrow`** — generalised escrow primitive for the broader Kajota commerce surface (commercialised in the ETHGlobal NY submission).

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
│           CosellRegistry  ✅ deployed (Ethereum Sepolia)         │
│                                                                   │
│   register(productId, wholesaler, coseller, bps, currency)       │
│   → emits ListingRegistered                                       │
│   → listingId = keccak256(productId, wholesaler, coseller)        │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  ▼  (referenced by listingId)
┌──────────────────────────────────────────────────────────────────┐
│           CosellEscrow  ✅ deployed (Ethereum Sepolia)           │
│                                                                   │
│   deposit(listingId, gross)        ← buyer transfers USDC        │
│   release(depositId)               ← releaseAuth (Verifier)      │
│   refund(depositId)                ← buyer, post-timeout         │
│     ↓                                                             │
│   coseller wallet gets commissionBps share                       │
│   wholesaler wallet gets remainder                                │
└─────────────────────────────────┬────────────────────────────────┘
                                  ▲
                                  │ release() call
┌─────────────────────────────────┴────────────────────────────────┐
│      CosellShipmentVerifier  ✅ deployed (Ethereum Sepolia)      │
│                                                                   │
│   Extends Chainlink FunctionsClient (v1.5.0).                    │
│   requestShipmentVerification(depositId, orderId)                │
│   → DON runs packages/attestation/source.js                      │
│   → fetches Kajota attestation, verifies orderId + shipment      │
│   → callback decodes the prefix-bound flag → calls escrow.release│
└──────────────────────────────────────────────────────────────────┘
```

## Deployed addresses

### Ethereum Sepolia (chainId 11155111)

| Contract | Address |
|---|---|
| `CosellRegistry` | [`0xfce6bd68d8d6f858d447f537d206c1e354b44315`](https://sepolia.etherscan.io/address/0xfce6bd68d8d6f858d447f537d206c1e354b44315) |
| `CosellEscrow` | [`0x599869cef2e4c52e2c9074caaf8f9fb0cb191776`](https://sepolia.etherscan.io/address/0x599869cef2e4c52e2c9074caaf8f9fb0cb191776) |
| `USDC` (Circle) | [`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`](https://sepolia.etherscan.io/address/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238) |
| Chainlink Functions DON | `fun-ethereum-sepolia-1` |

Full manifest: [`packages/contracts/deployments/11155111.json`](packages/contracts/deployments/11155111.json).

### Arbitrum Sepolia (chainId 421614)

Live for the Arbitrum Open House London buildathon (Jun 14, 2026). Same deployer + same nonce 0 → same contract addresses as Ethereum Sepolia (CREATE is deterministic).

| Contract | Address |
|---|---|
| `CosellRegistry` | [`0xfce6bd68d8d6f858d447f537d206c1e354b44315`](https://sepolia.arbiscan.io/address/0xfce6bd68d8d6f858d447f537d206c1e354b44315) |
| `CosellEscrow` | [`0x599869cef2e4c52e2c9074caaf8f9fb0cb191776`](https://sepolia.arbiscan.io/address/0x599869cef2e4c52e2c9074caaf8f9fb0cb191776) |
| `USDC` (Circle) | [`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`](https://sepolia.arbiscan.io/address/0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d) |

Full manifest: [`packages/contracts/deployments/421614.json`](packages/contracts/deployments/421614.json).

### Base Sepolia (chainId 84532)

Deploy script ready; not yet deployed. Run `pnpm --filter @kajota-mesh/contracts deploy:base-sepolia` with a funded EOA.

### Mantle Sepolia (chainId 5003)

Deploy script ready; not yet deployed. Required for the Mantle Turing Test Phase 2 submission (Jun 15). Run `pnpm --filter @kajota-mesh/contracts deploy:mantle-sepolia`.

## Repo layout

```
kajota-mesh/
├── packages/
│   ├── contracts/             Hardhat 3 (TS + viem). Solidity 0.8.24, EVM Cancun.
│   │   ├── contracts/
│   │   │   ├── CosellRegistry.sol           ✅ live
│   │   │   ├── CosellEscrow.sol             ✅ live
│   │   │   ├── CosellShipmentVerifier.sol   ✅ live (Chainlink Functions consumer)
│   │   │   └── KajotaEscrow.sol             ✅ live (generalised primitive)
│   │   ├── test/                            47 tests across 4 contracts
│   │   ├── deployments/                     per-chain manifests
│   │   └── hardhat.config.ts                Sepolia / Base Sepolia / Mantle Sepolia
│   └── attestation/                         Chainlink Functions DON source.js
├── apps/
│   └── docs/                  Whitepaper + architecture (not yet authored)
├── pnpm-workspace.yaml
└── package.json
```

Mirrors [`kajota-concierge`](https://github.com/KaJota-inc/kajota-concierge) (also Hardhat 3 + viem) so the two sibling repos share toolchain and conventions.

## Running locally

```bash
# Hardhat 3 requires Node ≥ 22.13.0.
nvm use 22

pnpm install
pnpm test                 # 47 tests across the 4 contracts on the in-process EDR chain
pnpm --filter @kajota-mesh/contracts compile

# Deploy (needs DEPLOYER_PRIVATE_KEY funded with testnet ETH).
pnpm --filter @kajota-mesh/contracts deploy:sepolia
pnpm --filter @kajota-mesh/contracts deploy:base-sepolia
pnpm --filter @kajota-mesh/contracts deploy:mantle-sepolia
```

## Status

- [x] Repo scaffold, Hardhat 3 + viem + OpenZeppelin 5.1
- [x] `CosellRegistry.sol` (register / deactivate / read / split-math) — 11 unit tests
- [x] `CosellEscrow.sol` (USDC deposit + auto-split release + buyer refund-after-timeout) — 12 unit tests
- [x] `CosellShipmentVerifier.sol` (Chainlink Functions consumer + prefix-bound callback) — 8 unit tests
- [x] `KajotaEscrow.sol` (generalised escrow primitive for the broader marketplace) — 27 unit tests
- [x] Chainlink Functions attestation source (`packages/attestation/source.js`)
- [x] Deploy to Ethereum Sepolia + on-chain verification
- [ ] Deploy to Base Sepolia
- [ ] Deploy to Mantle Sepolia (required for Mantle Turing P2 submission)
- [ ] Coach Agent v2 `publishListing` tool wired to mint on-chain
- [ ] Mobile-side `PaymentOptionModal` extension to call `CosellEscrow.deposit` (ETHGlobal NY submission)
- [ ] Demo videos for each submission

## License

MIT — see [`LICENSE`](LICENSE).
