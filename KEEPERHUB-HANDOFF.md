# Kajota × KeeperHub — Handoff Notes

Full state of the Kajota × KeeperHub build for the DoraHacks *Agents Onchain* hackathon. If you (or future-me) opens this cold, everything you need to run, verify, or extend the integration is on this page.

> **Submission status (2026-07-29):** BUIDL submitted on DoraHacks · Bounty applied · OSS PR open · Live URL + demo video live. Judging window Aug 13–20; winners announced Aug 20.

---

## The one-paragraph pitch

A KeeperHub workflow schedules `CosellEscrow.release(depositId)` on Ethereum Sepolia. The keeper wallet is a Turnkey account whose authority the escrow accepts via EIP-7702. When a buyer deposits USDC, our console posts the depositId to KeeperHub; ~15 s later the release tx lands and USDC splits 85/15 between wholesaler and coseller. Kajota Coach never sees a private key, never eats gas volatility, never handles retries. **KeeperHub is exactly the last-mile-execution layer between what an agent decides and confirmed on-chain state.**

---

## The three URLs a judge needs

| What | URL |
|---|---|
| Live console (Connect wallet → deposit → auto-release) | https://kajota-hub.onrender.com/keeperhub |
| Live release tx on Sepolia | https://sepolia.etherscan.io/tx/0xc0acf8ed666ad5c990cc1f10f76baddbef7743b8784bd9989ff307fd300354b0 |
| Demo video (2m 13s, real voice + word subs) | https://youtu.be/7ltsrdlQGNI |

Bonus: the KeeperHub workflow itself — https://app.keeperhub.com/workflows/1pyjp0c15z2h558jld8pn

---

## Architecture, single diagram

```
     Buyer (any Sepolia wallet, e.g. MetaMask)
                    │
                    │  1. approve(USDC → escrow, 0.10)
                    │  2. deposit(listingId, 100000)
                    ▼
      ┌─────────────────────────────────────────┐
      │ CosellEscrow  0x599869cef2e4c52e2c…1776 │
      │   emits: Deposited(depositId, …)        │
      └─────────────────────────────────────────┘
                    │
                    │  frontend extracts depositId from event
                    ▼
      ┌─────────────────────────────────────────┐
      │ kajota-hub.onrender.com/keeperhub       │
      │ (Node keeperhub-escrow service, :8108)  │
      │                                         │
      │  POST /demo-release { depositId }       │
      │   ↓                                     │
      │  POST app.keeperhub.com/api/workflows/  │
      │       {id}/execute                      │
      │       { "input": { "depositId": … } }   │
      └─────────────────────────────────────────┘
                    │
                    │  KH Turnkey signs via EIP-7702
                    │  (delegator = 0x4c629AD0…FE493bc2)
                    ▼
      ┌─────────────────────────────────────────┐
      │ CosellEscrow.release(bytes32 depositId) │
      │   splits USDC 85/15                     │
      │   emits: Released(depositId, …)         │
      └─────────────────────────────────────────┘
```

---

## Repos and where things live

| Repo | Branch | What's on it |
|---|---|---|
| [`KaJota-inc/kajota-mesh`](https://github.com/KaJota-inc/kajota-mesh) | `hackathon/keeperhub` | Solidity contracts (`packages/contracts/contracts/CosellEscrow.sol`), deploy scripts, one-command Hardhat demo runner (`pnpm --filter @kajota-mesh/contracts keeperhub-demo:sepolia`), workflow config (`packages/contracts/deployments/keeperhub.json`), this file, and [`SUBMISSION-KEEPERHUB.md`](https://github.com/KaJota-inc/kajota-mesh/blob/hackathon/keeperhub/SUBMISSION-KEEPERHUB.md) |
| [`KaJota-inc/kajota-hub`](https://github.com/KaJota-inc/kajota-hub) | `main` | Single Render service hosting the escrow console at `/keeperhub` — Node http server (`apps/keeperhub-escrow/server.mjs`), no-build ESM frontend with `viem@2` via `esm.sh` for wallet-connect (`apps/keeperhub-escrow/app.js`, `apps/keeperhub-escrow/index.html`), Caddy route + supervisord entry |
| [`KaJota-inc/kajota-coach`](https://github.com/KaJota-inc/kajota-coach) | `hackathon/keeperhub` | Coach agent branch — placeholder for the future x402 wrapper and agent-tool wiring (not shipped in this iteration; see "Known gaps" below) |
| [`KaJota-inc/keeperhub-1`](https://github.com/KaJota-inc/keeperhub-1) | `kajota/dx-onboarding-fix` | Fork of `KeeperHub/keeperhub` OSS. Source of PR [#1857](https://github.com/KeeperHub/keeperhub/pull/1857) |

**Do NOT use** `KaJota-inc/keeperhub` (no `-1` suffix) — that's a pre-existing unrelated fork of `vercel-labs/workflow-builder-template`.

---

## On-chain artefacts (Sepolia)

| Thing | Address / hash |
|---|---|
| CosellEscrow | `0x599869cef2e4c52e2c9074caaf8f9fb0cb191776` |
| CosellRegistry | `0xfce6bd68d8d6f858d447f537d206c1e354b44315` |
| Test USDC (Circle) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Deployer / wholesaler EOA | `0xe10cff27c99074cd44c64bed1b000226442524a4` |
| KH keeper Turnkey wallet (releaseAuth) | `0x4c629AD055B3Ad07beF13b3b2f47E74aFE493bc2` |
| Demo coseller (burn addr) | `0x000000000000000000000000000000000000dEaD` |
| Demo listingId | `0x22d917c51456ff35e7e678534cc6059d86659e0bfa926bf137e036cf6f9a7426` (productId `KH-DEMO-1784730454`, 1500 bps commission) |
| Demo depositId (already released) | `0xe713d5a3eb6c0c3c247e3c86ad23696e006c6097de47d5fad9a303838f0f2d13` |
| `setReleaseAuth` tx (rotated to KH keeper) | [`0x5ef9ae96…b673c`](https://sepolia.etherscan.io/tx/0x5ef9ae966c7a8c83ac7e20f05f373264cd2e196f429254640928d14a8d4b673c) — block 11326289 |
| First end-to-end release tx | [`0xc0acf8ed…354b0`](https://sepolia.etherscan.io/tx/0xc0acf8ed666ad5c990cc1f10f76baddbef7743b8784bd9989ff307fd300354b0) — block 11327270, 154 384 gas, 14 541 ms end-to-end |

Full lineage of every tx in the demo is pinned at [`packages/contracts/deployments/keeperhub.json`](packages/contracts/deployments/keeperhub.json).

---

## Reproduce end-to-end in one command

```bash
# from kajota-mesh repo root
git checkout hackathon/keeperhub
pnpm install

# .env at repo root needs:
#   DEPLOYER_PRIVATE_KEY=<sepolia EOA with ~$1 sETH + a little USDC>
#   KEEPERHUB_API_KEY=kh_...   (from app.keeperhub.com → Settings → API Keys)

pnpm --filter @kajota-mesh/contracts keeperhub-demo:sepolia
```

That script does the full lifecycle in one go: register a listing → approve USDC → deposit → POST to KH `/api/workflows/{id}/execute` → poll for the release tx → decode the `Released` event and print USDC split. Takes ~40 s wall-clock, spends ~$0.10 test USDC + a fraction of a cent of sETH.

For the browser flow, open https://kajota-hub.onrender.com/keeperhub, click **Connect Sepolia wallet**, and follow the on-screen path.

---

## Bounty positioning ("Best Onboarding UX Improvement")

The bounty description accepts *"a merged PR to the KeeperHub repo, a starter template, a tutorial, or a clear teardown of where you got stuck with proposed fixes."*

Our entry: **[KeeperHub/keeperhub#1857](https://github.com/KeeperHub/keeperhub/pull/1857)** — hits forms 1 and 4 simultaneously.

- Docs-only, 64 additions, zero code changes
- Two files: `docs/api/workflows.md` (adds a generic `web3/write-contract` example next to the Aave one) + `docs/plugins/web3.md` (adds a UI-label ↔ API-field mapping table on the Write Contract entry)
- Every trap has a proposed fix inline
- Verified against a live workflow (`1pyjp0c15z2h558jld8pn`) and a real release tx

Attached to the bounty on DoraHacks via the Bounty Application flow (bounty ID: "Best Onboarding UX Improvement", pool: 1,000 USDC/USDT split up to 2 winners).

---

## The three field-name traps the PR fixes

1. **`abiFunction`, not `function` / `functionName` / `method`.** The strict validator rejects the natural-language names with `UNKNOWN_FIELD`.
2. **`functionArgs` is a JSON-encoded array *string*, not a raw array.** For `release(bytes32 depositId)`: `"functionArgs": "[\"{{@trigger-1:HTTP.depositId}}\"]"`. Templates go inside the string quotes. Bare template resolutions fail `JSON.parse` at runtime, not at save time — worst DX moment we hit.
3. **HTTP-trigger inputs use the stored-format template.** `{{@trigger-1:HTTP.depositId}}`, not `{{@trigger.body.depositId}}` (the current docs example). Also, `POST /execute` body must wrap under `input` — bare `{"depositId": "0x…"}` gives an empty `trigger.input` and every template goes unresolved.

Same three are documented in more depth in [`SUBMISSION-KEEPERHUB.md#dx-teardown-for-the-onboarding-ux-bounty`](SUBMISSION-KEEPERHUB.md#dx-teardown-for-the-onboarding-ux-bounty).

---

## Known gaps (honest, submitted as-is)

Copied verbatim from the DoraHacks submission's "What still breaks or is unfinished" answer:

1. **Coach agent tool wiring**: the live console proves the mechanism (merchant clicks Fire → KH signs release), but Coach doesn't call KH autonomously yet. Next: agent tool `schedule_release(depositId, deliveryProof)` posts to `/demo-release` from within Coach's Google ADK loop.
2. **Mainnet not wired**: KH's x402 payment layer is Base mainnet USDC; we use Sepolia + KH gas-sponsored keeper (recommended in KH quickstart). Moving to mainnet is a chain-id swap + `setReleaseAuth` on the mainnet escrow.
3. **`/demo-release` endpoint has no per-caller auth right now** — anyone hitting `kajota-hub.onrender.com/keeperhub` can fire KH executions against our workflow. KH rate limits cap blast radius; prod needs HMAC + nonce.
4. **Demo listing on Sepolia was manually seeded** — a real merchant onboarding UX doesn't exist yet.

---

## Post-Aug 20 checklist

1. **Rotate the KeeperHub API key**. The current `kh_pypg1J6-z-qmDg9LOiKgXFxDj03DxtDk` was pasted in a chat transcript (compromised per [[feedback_credentials_in_chat]]). At `app.keeperhub.com` → Settings → API Keys → Revoke + Create new → update `KH_API_KEY` on Render (kajota-hub → Environment).
2. **Check the DoraHacks winners announcement** at https://dorahacks.io/hackathon/agents-onchain/detail.
3. **Follow up on PR [#1857](https://github.com/KeeperHub/keeperhub/pull/1857)** — respond to review comments, ship any requested revisions.
4. **Decide whether to close or extend** — if we're going to push this further, the natural next steps are:
   - Wire Coach agent tool `schedule_release` (unblocks the autonomous story)
   - Add HMAC to `/demo-release`
   - Deploy a mainnet Cosell escrow and repoint releaseAuth
   - Slot the Casper x402 code back in as a two-tier x402 (~5–8 hr port, see [[project_casper_buildathon]])

---

## Session mechanics that mattered (for anyone driving MCP flows on DoraHacks)

- DoraHacks Vue modals throttle badly when Chrome isn't the macOS-frontmost app. `document.hasFocus()` returning `true` is the reliable signal.
- The rich-text editor on the Details step is a contenteditable div; use `document.execCommand('selectAll') + delete + insertText` — direct `innerText` assignment gets rejected.
- Custom `.dh-select-style` dropdowns need real CDP mouse clicks (`computer.left_click` at fresh `getBoundingClientRect()` coords), not programmatic pointer events.
- DoraHacks has scheduled maintenance windows during which some Vue click handlers stop responding; if a click won't take after two coord retries, check the top-of-page banner.
- File uploads via the `file_upload` MCP tool restrict paths — inline a base64 → `File` → `DataTransfer` → set `input.files` if the target file isn't shareable.

---

## Related memories (auto-memory index)

`project_keeperhub_hackathon` (this project's memory file) · `project_coach_mesh` (Coach + Mesh repos) · `kajota-hub` (deployment target) · `project_casper_buildathon` (x402 source pattern) · `hackathon-winning-playbook` (framing) · `feedback_credentials_in_chat` (why to rotate the key)
