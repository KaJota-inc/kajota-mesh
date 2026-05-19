# @kajota-mesh/attestation

> Chainlink Functions source script for the Kajota Mesh release path.

## What this does

When a buyer deposits USDC into `CosellEscrow`, funds sit there until the wholesaler ships the product. The contract needs an *honest* confirmation that shipment happened before it releases the escrow — otherwise either:

- the buyer pays for a product they never receive, **or**
- the wholesaler holds the buyer hostage forever (mitigated by the 14-day refund safety net, but that's a fallback, not a feature).

The honest signal lives in Kajota's backend (`OrderPayment` document, status: `SHIPPED`). Chainlink Functions is the trust-minimised bridge: the Decentralized Oracle Network calls a Kajota REST endpoint, hashes the result, and posts it back on-chain.

```text
┌──────────────────┐       ┌─────────────────────────┐
│ CosellShipment   │ req → │  Chainlink Functions    │
│ Verifier         │       │  DON (Base Sepolia,     │
│ (next commit)    │ ← cb  │   ~4 nodes, threshold)  │
└──────────────────┘       └────────────┬────────────┘
        │                                │
        ▼                                ▼  source.js runs here
   CosellEscrow                ┌───────────────────────┐
   .release(...)               │ Kajota backend        │
                               │ GET /coach/agent/     │
                               │ shipment-attestation  │
                               └───────────────────────┘
```

## Source script (`source.js`)

Inputs (passed via `args` from the consumer contract):

| index | name | format |
|---|---|---|
| `args[0]` | `depositId` | `bytes32` hex (`0x…`, 66 chars) |
| `args[1]` | `kajotaOrderId` | Mongo ObjectId (24 hex chars) |

DON-encrypted secrets:

| key | purpose |
|---|---|
| `kajotaAttestationBase` | base URL of the Kajota backend (e.g. `https://kajota-mobile-backend-2.onrender.com/kajota-mobile-backend`) |
| `kajotaToken` | service-account bearer scoped to the attestation endpoint |

Return: a single `bytes32` packing `[depositIdPrefix (16B) | orderIdPrefix (15B) | verifiedFlag (1B)]`. The consumer contract checks the flag byte and verifies the prefixes match what it requested — prevents callback substitution attacks.

## How to deploy on Chainlink Functions

> The full Functions toolkit lives at https://docs.chain.link/chainlink-functions. The TL;DR for this repo:

```bash
# 1. Make sure the .env at the repo root has the required vars:
cp .env.example .env
# fill DEPLOYER_PRIVATE_KEY, BASESCAN_API_KEY, CHAINLINK_FUNCTIONS_SUB_ID, etc.

# 2. Use the Chainlink Functions toolkit to upload the encrypted secrets
#    (one-time per DON, expires after 60 days unless renewed):
npx @chainlink/functions-toolkit secrets upload \
  --network baseSepolia \
  --secrets kajotaToken=$KAJOTA_ATTESTATION_TOKEN \
  --secrets kajotaAttestationBase=$KAJOTA_ATTESTATION_BASE

# 3. Test the source locally before going to chain (Functions toolkit
#    has a `simulateScript` command that runs source.js in a deno-like
#    sandbox identical to the DON's):
npx @chainlink/functions-toolkit simulate \
  --source packages/attestation/source.js \
  --args 0xabcd...,6a0b4c3d6df81b631aa879ab

# 4. The on-chain CosellShipmentVerifier (landing next commit) calls
#    FunctionsRequest.Request with the encryptedSecretsReference + this
#    source.js + the subscription ID. The DON returns the bytes32
#    above via fulfillRequest(); verifier checks the prefix bytes
#    and the verifiedFlag, then calls escrow.release(depositId).
```

## Backend endpoint contract

The Kajota backend must expose:

```
GET  /coach/agent/shipment-attestation?orderId=<id>
     Authorization: Bearer <kajotaToken>

200  { responseCode: "000",
       payload: {
         orderId:       string,    // echo
         shipped:       boolean,   // true iff OrderPayment.status == SHIPPED
         shippedAt:     ISO8601 | null,
         attesterUserId: string    // user id that confirmed shipment
       } }
404  order not found
401  bad token
```

Wiring this on the backend is a **separate commit on `kajota-mobile-backend`** — likely `hackathon/mesh-attestation`. Out of scope for this repo's tests but called out in the integration plan so it doesn't get forgotten.

## Security notes

- The `kajotaToken` secret is encrypted with the DON's public key and decrypted only inside the DON sandbox. It is **never** stored in clear on chain or in the consumer contract.
- The consumer contract MUST check that the returned `depositIdPrefix` matches the one it asked about — otherwise a malicious operator could re-use a single attested response across many deposits.
- The 15-byte `orderIdPrefix` is informational only (Mongo ObjectIds are 12 bytes / 24 hex chars; the extra 3 bytes are zero padding). A future hardened version can derive both prefixes from a single deterministic commitment to prevent any callback-swapping.
