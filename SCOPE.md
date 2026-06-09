# Next-session scope: CosellEscrow → demo-ready across 3 hacks

**Drafted:** Jun 8, 2026.
**Target hackathons this work serves:**
- ETHGlobal NY 2026 (Jun 12-14) — escrow-on-chain submission
- AWS Activate Web3 — mesh's on-chain settlement narrative
- Mantle Turing Test Phase 2 (Jun 15, combined w/ Coach Agent v2) — mesh deployed to Mantle Sepolia

One contract, three demos. Ordering chosen so the latest deadline (Jun 15) catches everything earlier in the sequence.

---

## Current state (verified from git log Jun 8, 2026 — `hackathon/escrow` HEAD = f5babc8)

| Contract | Lines | Tests | Status |
|---|---|---|---|
| `CosellRegistry.sol` | 232 | ~existing | Live on Base Sepolia |
| `CosellEscrow.sol` | 268 | **12 tests** (commit `5f17937`) | Deployed to Base Sepolia + Ethereum Sepolia |
| `CosellShipmentVerifier.sol` | 302 | **8 tests** (commit `c18d25c`) | Chainlink Functions consumer, deployed |
| `KajotaEscrow.sol` | 323 | **27 tests** (commit `f5babc8`) | Built |

**47 tests across the escrow-side contracts.** This work landed between the previous session and now.

**Not yet deployed:** Mantle Sepolia (only deploy target left for Phase 2 Mantle Turing).
**README is stale** — flip "⏳ next" claims to reflect what's now shipped.

### CosellEscrow public surface (verified)

```solidity
function deposit(bytes32 listingId, uint256 grossAmount) external nonReentrant;
function release(bytes32 depositId) external nonReentrant;     // releaseAuth only
function refund(bytes32 depositId) external nonReentrant;       // buyer, post-timeout
function setReleaseAuth(address next) external;                  // admin
function getDeposit(bytes32 depositId) external view returns (...);

event Deposited / Released / Refunded / ReleaseAuthUpdated
error InvalidUsdc / InvalidRegistry / InvalidReleaseAuth / ZeroAmount
      ListingNotActive / DepositNotFound / DepositNotPending
      NotReleaseAuth / NotBuyer / RefundTooEarly
```

The shape matches what ETHGlobal NY's "real-world payments" angle expects.

---

## Setup (5 min, mandatory)

```sh
# Hardhat 3 requires Node ≥ 22.13.0. Current Mac is on 20.14.0.
nvm install 22.13.0 && nvm use 22.13.0
cd ~/Documents/GitHub/kajota-mesh
pnpm install
pnpm --filter @kajota-mesh/contracts test
# expect: 4 test files passing (Registry, Escrow, Verifier, KajotaEscrow)
```

If tests fail, that's the first blocker — fix before deploying.

---

## Session task list (sequenced, ≈ 5-8 hours total — substantially less than first-draft estimate because the contract layer is already done)

### Phase A — Mesh polish (30 min — 1 hr)

1. **Run all tests on Node 22.** `pnpm --filter @kajota-mesh/contracts test`. Expect 47+ tests passing across the escrow contracts.
2. **Confirm Base Sepolia deploy addresses** are populated in `.env.example` per the `# ---- Reference deployed addresses ----` section. If missing: read them off the Sepolia commits (`1e5fd98` + `bbbac4a`) and update.
3. **Update `README.md`** — flip the `CosellEscrow` "⏳ next" stub to "✅ deployed (Base Sepolia + Ethereum Sepolia)" with the actual addresses. Add a third row once Mantle Sepolia lands.

### Phase B — Mantle Sepolia deploy + Chainlink wiring (1-2 hrs)

4. **Mantle Sepolia deploy** — only chain not yet covered. `pnpm --filter @kajota-mesh/contracts deploy:mantle-sepolia` against a funded EOA.
5. **Provision Chainlink Functions subscription** if not already done — Base Sepolia at <https://functions.chain.link>. Fund with LINK from a testnet faucet. Wire the subscription id into the `CosellShipmentVerifier`.
6. **Smoke test the deposit → release flow** end-to-end: register a listing → deposit USDC → trigger the Verifier's DON callback → confirm split lands.

### Phase C — Mobile integration (3-4 hrs, on `kajota` mobile repo)

9. **Cut `hackathon/escrow` on mesh** if not already. (Mobile already has it.)
10. **Mobile side: extend `src/pages/Home/OrderPayment/PaymentOptionModal.tsx`** — add a "Pay with Stablecoin (Escrow)" tile alongside Stripe. Wire it to:
    - Privy embedded wallet (per the existing `privySigner.tsx` pattern)
    - `viem`-based `writeContract` call to `CosellEscrow.deposit(listingId, grossAmount)`
11. **Surface deposit status** in the order detail screen — read `getDeposit(depositId)` for "pending / released / refunded" state.
12. **Wire LI.FI bridge** (optional — adds the cross-chain pay-in story for ETHGlobal NY). Defer if time-tight.

### Phase D — Demo recordings (2-3 hrs, split across hacks)

13. **ETHGlobal NY demo** (≤4 min): order checkout → choose Stablecoin → Privy approval → deposit lands on Base Sepolia → ship event triggers release → split lands in wholesaler + coseller wallets.
14. **Mantle Turing Phase 2 demo**: same flow but on Mantle Sepolia. Coach Agent v2 drafts the listing → `CosellRegistry.register` → buyer purchase → CosellEscrow flow → settlement.
15. **AWS Activate Web3 application**: probably mostly text + repo links (verify the form — may not need a video).

---

## Sub-tasks that are NOT in this scope

- **Privy app provisioning** for hack build (handled by the hack EAS profile — separate task per `kajota/HACKS.md`).
- **Render env groups** for any hosted service — none needed; Mesh contracts are deployed, not hosted.
- **AWS Activate Web3 application form** — likely separate; depends on what AWS asks for.

---

## Submission targets recap

| Hack | Deadline | What lands |
|---|---|---|
| ETHGlobal NY | Jun 12-14 | Repo link + demo video + Base Sepolia addresses + writeup |
| Mantle Turing Phase 2 | Jun 15 | Repo link + demo video + Mantle Sepolia addresses + Coach Agent v2 integration writeup |
| AWS Activate Web3 | Check page | TBD format |

---

## Confidence

Contracts exist and have tests; the long pole is the **mobile integration** + the **Chainlink Functions DON subscription wiring**. The deploy step is mostly mechanical once the deployer EOA is funded.

If a phase slips, the priority order to cut is: D14 (Mantle demo) > C12 (LI.FI) > A2-3 (deep audits). Phases A1, B5-8, and C10-11 are the non-negotiable core.
