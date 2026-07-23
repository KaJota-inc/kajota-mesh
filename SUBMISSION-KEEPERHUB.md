# Kajota × KeeperHub — Agents Onchain 2026

**One-liner.** A KeeperHub workflow schedules `CosellEscrow.release(depositId)` on Ethereum Sepolia. The keeper wallet is a Turnkey account whose authority the escrow contract accepts via EIP-7702. USDC splits between wholesaler and coseller in one keeper-signed tx, ~15 s after the merchant asks Coach for a release.

**Prize track.** Grand Prize (execution weighted heavily) + Best Onboarding UX Improvement (dev-experience teardown in [DX teardown](#dx-teardown-for-the-onboarding-ux-bounty)).

**Live artefacts.**

| What | Link |
|---|---|
| Live release tx | [sepolia.etherscan.io/tx/0xc0acf8…354b0](https://sepolia.etherscan.io/tx/0xc0acf8ed666ad5c990cc1f10f76baddbef7743b8784bd9989ff307fd300354b0) |
| Live console (click "Fire release") | [kajota-hub.onrender.com/keeperhub](https://kajota-hub.onrender.com/keeperhub) |
| KeeperHub workflow | [app.keeperhub.com/workflows/1pyjp0c15z2h558jld8pn](https://app.keeperhub.com/workflows/1pyjp0c15z2h558jld8pn) |
| Contracts + one-command demo | [github.com/KaJota-inc/kajota-mesh](https://github.com/KaJota-inc/kajota-mesh) |
| Coach agent | [github.com/KaJota-inc/kajota-coach](https://github.com/KaJota-inc/kajota-coach) |
| Hub deployment | [github.com/KaJota-inc/kajota-hub](https://github.com/KaJota-inc/kajota-hub) |
| Demo video (50s) | *[replace with published URL after upload]* |

---

## What we built

**Kajota Mesh** is a live escrow rail on Ethereum Sepolia for cross-border consignment sales: a *wholesaler* lists a product, a *coseller* resells with a commission, a *buyer* deposits USDC, and — after delivery is attested — the escrow releases the funds and splits them by the listing's `commissionBps`. The full contract set (`CosellRegistry`, `CosellEscrow`, USDC-adapter) is 27+ Hardhat tests + a permissioned `releaseAuth` that can only fire `release()`. See [`packages/contracts/contracts/CosellEscrow.sol`](https://github.com/KaJota-inc/kajota-mesh/blob/hackathon/keeperhub/packages/contracts/contracts/CosellEscrow.sol).

**The gap KeeperHub fills.** Kajota's Coach agent (Gemini 2.5 Pro + Google ADK + MongoDB MCP) can decide when a delivery has landed. But *submitting* the release tx is the hard part: gas volatility, retries, keeper-key custody, MEV. Building any of that in-house means becoming a keeper platform, which is not the Kajota product. **KeeperHub is exactly the layer that runs.**

**The integration is one workflow.**

1. `set-release-auth` (Sepolia tx [0x5ef9…b673c](https://sepolia.etherscan.io/tx/0x5ef9ae966c7a8c83ac7e20f05f373264cd2e196f429254640928d14a8d4b673c)) rotates the escrow's `releaseAuth` from the deployer EOA to the KeeperHub-provisioned Turnkey wallet `0x4c629AD0…FE493bc2`. Only this address can now call `release()`.
2. A KeeperHub workflow with an **HTTP trigger** and a **`web3/write-contract`** action is created via KH's REST API (workflow id `1pyjp0c15z2h558jld8pn`). The action calls `release(bytes32 depositId)`, reading `depositId` from the trigger's input via the template `{{@trigger-1:HTTP.depositId}}`.
3. Coach (or any client — for the demo, a static console page) POSTs `{"input":{"depositId":"0x…"}}` to `/api/workflows/{id}/execute` with the org API key. KH's Turnkey wallet **delegates via EIP-7702**, signs, and submits `release()` on Sepolia. The `Released` event fires; USDC transfers to wholesaler and coseller land in the same tx.

Nothing about that flow is a mock. The [console](https://kajota-hub.onrender.com/keeperhub)'s "Fire release" button re-invokes the exact same workflow on every click — see `Recent runs` on the console for the live history.

---

## The demo transaction

One command, real Sepolia tx, real KH-driven release:

```bash
pnpm --filter @kajota-mesh/contracts keeperhub-demo:sepolia
```

reproduced end-to-end on **Jul 22 2026** with these hashes:

| Stage | Tx | Block |
|---|---|---|
| Register listing | [0x87a1b5…6808](https://sepolia.etherscan.io/tx/0x87a1b57237d7c09aae6f553ca80e6fe6d25d398dbe2b2bbf05094ec5b2806808) | 11,327,266 |
| Approve USDC | [0xd43d3c…73fb](https://sepolia.etherscan.io/tx/0xd43d3c83ed39c6929b2eac5ad3939655843d49179e7c90e3a6d92c669db973fb) | — |
| Buyer deposit | [0x490aa1…3fd4](https://sepolia.etherscan.io/tx/0x490aa197817e8d652e26445635da37e437c24c903f55ca76c4de620dd9f83fd4) | — |
| **KH-driven release** | **[0xc0acf8…354b0](https://sepolia.etherscan.io/tx/0xc0acf8ed666ad5c990cc1f10f76baddbef7743b8784bd9989ff307fd300354b0)** | **11,327,270** |

The release tx's `Released` event confirms `depositId=0xe713d5a3…2d13`, `listingId=0x22d917c5…7426`, and USDC transfers of **0.085 → wholesaler** and **0.015 → coseller** (85 / 15 split at 1500 bps commission). KH's execution took 14,541 ms end-to-end from `POST /execute` to `status=success` (`executionId=ayh0x4409maep14aek6yt`).

The full flow — including workflow config, KeeperHub Turnkey wallet, x402 hooks — is pinned in [`packages/contracts/deployments/keeperhub.json`](https://github.com/KaJota-inc/kajota-mesh/blob/hackathon/keeperhub/packages/contracts/deployments/keeperhub.json).

---

## Mapping to the judging criteria

| Criterion | How we hit it |
|---|---|
| **Does it execute onchain via KeeperHub?** | Yes. Every release path in the demo is a KH-signed Sepolia tx submitted via EIP-7702. The linked [release tx](https://sepolia.etherscan.io/tx/0xc0acf8ed666ad5c990cc1f10f76baddbef7743b8784bd9989ff307fd300354b0) is the one KH executed. |
| **Use of KeeperHub surfaces** | Workflow builder (HTTP trigger + `web3/write-contract` action), org API key, `/api/workflows/{id}/execute`, `/executions` polling, Turnkey wallet with EIP-7702 delegation, KH dashboard for observability. |
| **Reliability & observability** | The escrow's `releaseAuth` is a single-purpose keeper — even if the KH key leaks, blast radius is one contract's `release()` on Sepolia. KH's audit trail surfaces every trigger, tx hash, gas used. Console shows both success and revert paths (idempotency guard) as first-class outcomes. |
| **Originality & real-world usefulness** | Kajota is an actual multi-country cosell rail (mobile app live on both stores). Cross-border consignment escrow with commission splits is a real fintech product; the "hardest part is releasing on time" pain is the exact pain KH removes. |
| **Integration quality & DX** | One-command reproducibility, isolated worktree with a live console URL, pinned config JSON, all workflow surfaces exercised. Every non-obvious KH-side gotcha we hit is captured in the [DX teardown](#dx-teardown-for-the-onboarding-ux-bounty) below. |

---

## Try it yourself

**Fastest — click the console.** Open [kajota-hub.onrender.com/keeperhub](https://kajota-hub.onrender.com/keeperhub). The "Fire release" button POSTs to the exact same KeeperHub workflow. The button re-fires the known-good depositId; it will revert on-chain because the deposit is already released (the escrow's idempotency guard), which is intentional — you see the full KH signing + submission + on-chain response.

**With Sepolia ETH — run the full lifecycle.**

```bash
git clone -b hackathon/keeperhub https://github.com/KaJota-inc/kajota-mesh
cd kajota-mesh
pnpm install
cp .env.example .env
# fill in DEPLOYER_PRIVATE_KEY (needs Sepolia ETH + Sepolia test USDC)
pnpm --filter @kajota-mesh/contracts keeperhub-demo:sepolia
```

Output prints all four tx hashes and the KH executionId, then polls until `status=success`. Costs ~0.10 USDC + ~0.0002 Sepolia ETH per run. Uses the same workflow every run — swap `KEEPERHUB_WORKFLOW_ID` to test against your own.

---

## Non-goals + tradeoffs

- **Coach x402 wrapper NOT yet plumbed through.** The concrete `POST /escrow/schedule-release` endpoint on Coach's FastAPI (with x402 paywall in front) is the natural next milestone — the release path is proven end-to-end, but this hackathon shipped without the merchant-facing paywall as a scoped choice. Full x402 impl already exists in a sibling worktree ([kajota-coach-casper](https://github.com/KaJota-inc/kajota-coach/tree/hackathon/casper)) — the [DX teardown below](#dx-teardown-for-the-onboarding-ux-bounty) covers why we didn't force-fit it.
- **Mainnet Ethereum with KeeperHub gas sponsorship.** The hackathon quickstart offers Sepolia as the recommended test path; we stayed there so the demo is reproducible from a public faucet. Moving to mainnet is a chain-id swap in `deployments/*.json` plus a one-line `setReleaseAuth` on the mainnet escrow.
- **No custom protocol registration in KH.** The escrow's ABI is embedded inline in the workflow's `abi` field, not registered as a protocol at the KH catalogue level. Fine for demo scope; a "Cosell Escrow" protocol contribution to the KH OSS `protocols/` directory is a natural follow-up PR.

---

## DX teardown (for the Onboarding UX bounty)

Two non-obvious traps we hit while integrating. Both cost real minutes; both are fixable with doc updates or a single validation-hint line. Recommend a PR to [`KeeperHub/keeperhub`](https://github.com/KeeperHub/keeperhub) covering these:

### 1. The `web3/write-contract` field names don't match `docs.keeperhub.com/plugins/web3`

The docs show:
```yaml
inputs:
  network: ethereum
  contractAddress: "0x..."
  abi: "{{ @trigger.contractABI }}"
  function: release
  functionArguments:
    depositId: "{{ @trigger.body.depositId }}"
```

The actual accepted schema (per `plugins/web3/steps/write-contract-core.ts`) is:
```ts
{ contractAddress, network, abi, abiFunction, functionArgs?, ethValue?, ... }
```

Neither `function` nor `functionArguments` are valid — the API returns `UNKNOWN_FIELD` on both. Correct names: `abiFunction` (string) and `functionArgs` (JSON-encoded string). The docs example would 422 today.

**Fix:** update the docs code sample. Optionally accept `function` / `functionArguments` as aliases in the API so old configs don't silently break. Suggested error message improvement: when a `UNKNOWN_FIELD` is close to a known one (`function` vs `abiFunction`), the error could hint the closest match.

### 2. `functionArgs` is a JSON-encoded STRING, not an array

`functionArgs` type is `string?`. For a single `bytes32 depositId`, the correct value is:
```json
"[\"{{@trigger-1:HTTP.depositId}}\"]"
```
Not `[{{...}}]` (that's YAML/parseable but the API stores it as an array of one string that then fails `JSON.parse` at runtime with `Unexpected non-whitespace character after JSON at position 1`).

The failure surfaces at execution time, not at workflow save time — a workflow saves cleanly, then errors on the first invoke. That's the single worst DX moment.

**Fix:** either (a) parse the stored `functionArgs` at save time and 422 with a helpful error before the workflow is enabled, or (b) accept `functionArgs` as a JSON array at the API layer and stringify server-side. Either eliminates the "saved fine, blew up at runtime" surprise.

### 3. HTTP trigger input access uses stored-format, not the doc example

Docs use `{{ @trigger.body.depositId }}`. The actual stored template resolver (per `lib/utils/template.ts`) only accepts three grammars: `{{@nodeId:Label.path}}`, `{{$nodeId.path}}`, `{{Label.path}}`. For the HTTP trigger's input, the correct form is `{{@trigger-1:HTTP.depositId}}`. Additionally, the `POST /execute` body must wrap the payload under `input` — bare `{"depositId": "0x…"}` produces an empty `trigger.input` and every template goes unresolved.

**Fix:** add a "First HTTP-triggered workflow" walk-through to the docs that shows the wrapped invocation body + the stored template syntax side-by-side. This is what would have saved us ~90 min.

---

## Repo layout

- **[`kajota-mesh`](https://github.com/KaJota-inc/kajota-mesh)** (`hackathon/keeperhub`) — contracts, deploy scripts, `keeperhub-demo:sepolia` runner, workflow config JSON.
- **[`kajota-coach`](https://github.com/KaJota-inc/kajota-coach)** (`hackathon/keeperhub`) — agent skeleton where the Coach x402 wrapper will slot in.
- **[`kajota-hub`](https://github.com/KaJota-inc/kajota-hub)** (`main`, merged from `hackathon/keeperhub`) — the `keeperhub-escrow` Node service that serves the live console.

## Team

Solo — [@bori7](https://github.com/bori7). Kajota builds cross-border consignment infrastructure for African commerce; Coach + Mesh are its escrow rail and the AI agent that drives it.
