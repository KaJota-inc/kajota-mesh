/**
 * Kajota Mesh — Chainlink Functions source script.
 *
 * Runs inside the Chainlink Decentralized Oracle Network (DON)
 * sandbox. Returns a single bytes32 that the on-chain consumer
 * (CosellShipmentVerifier — landing next commit) reads to decide
 * whether to call `CosellEscrow.release(depositId)`.
 *
 * Input (passed via `args` from the consumer contract):
 *   args[0]  depositId           — bytes32 hex, e.g. 0xabcd…
 *   args[1]  kajotaOrderId       — Mongo ObjectId hex string
 *
 * Secrets (DON-encrypted, set via Chainlink Functions toolkit):
 *   secrets.kajotaToken          — bearer for the attestation endpoint
 *   secrets.kajotaAttestationBase — base URL of the Kajota backend
 *
 * Return shape (Chainlink Functions DON serializes whatever `return`
 * resolves to via `Functions.encodeUint256` / `Functions.encodeString`
 * — we use `encodeBytes` of a 32-byte payload:
 *
 *   bytes32 = abi.encodePacked(
 *     bytes16(depositIdShort)  // first 16 bytes of the depositId
 *     bytes15(orderIdShort)    // first 15 chars of the orderId
 *     bytes1(verifiedFlag)     // 0x01 = SHIPPED, 0x00 = NOT_SHIPPED
 *   )
 *
 * On-chain we check the flag byte; the prefix bytes are just there
 * so a forged callback can't claim "the deposit was attested" for
 * a *different* deposit than the one originally requested.
 *
 * Why a single bytes32 rather than richer ABI: Chainlink Functions'
 * gas budget for response decode is bounded; bytes32 is the cheapest
 * decode on the consumer side. We trade richer return data for low
 * verifier gas — judges' demos will care.
 */

const depositId = args[0]; // 0x-prefixed 32-byte hex
const kajotaOrderId = args[1]; // 24-char ObjectId hex

if (!depositId || depositId.length !== 66 || !depositId.startsWith("0x")) {
  throw new Error(`Bad depositId: ${depositId}`);
}
if (!kajotaOrderId || kajotaOrderId.length !== 24) {
  throw new Error(`Bad kajotaOrderId: ${kajotaOrderId}`);
}

const base = secrets.kajotaAttestationBase;
const token = secrets.kajotaToken;
if (!base || !token) {
  throw new Error("Missing kajotaToken / kajotaAttestationBase secret");
}

// ---- 1. Ask Kajota whether the order has shipped -----------------
//
// Endpoint contract (to be added on the backend in commit #N):
//   GET <base>/coach/agent/shipment-attestation?orderId=<id>
//   Authorization: Bearer <token>
//
//   200 OK { responseCode: "000", payload: { orderId, shipped: bool,
//            shippedAt: ISO8601 | null, attesterUserId } }
//   404    order not found
//   401    bad token
//
// Functions' `Functions.makeHttpRequest` enforces a 9-second wall-clock
// ceiling; we set 6s explicitly so we still have room to encode the
// response before the DON times out.
const response = await Functions.makeHttpRequest({
  url: `${base}/coach/agent/shipment-attestation`,
  method: "GET",
  params: { orderId: kajotaOrderId },
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  timeout: 6000,
});

if (response.error) {
  throw new Error(
    `Kajota attestation HTTP error: ${response.error?.message ?? response.error}`,
  );
}
if (response.status !== 200) {
  throw new Error(
    `Kajota attestation HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 120)}`,
  );
}

const payload = response.data?.payload;
if (!payload || typeof payload.shipped !== "boolean") {
  throw new Error(
    `Kajota attestation: malformed payload — ${JSON.stringify(response.data).slice(0, 120)}`,
  );
}

const verifiedFlag = payload.shipped ? 0x01 : 0x00;

// ---- 2. Pack the response into a single 32-byte hex --------------
//
// First 16 bytes  = depositId[2..34]   (skip 0x, take 32 hex chars)
// Next  15 bytes  = first 15 hex chars of orderId (pad if shorter)
//                   right-padded to 30 hex chars, but kajotaOrderId
//                   is always 24 chars (12 bytes), so we use the
//                   first 12 bytes (=24 chars) + 3 zero bytes to fit.
// Last  1  byte   = verifiedFlag
//
// Total = 32 bytes = 64 hex chars + 0x.
const depositPrefix = depositId.slice(2, 2 + 32); // 16 bytes
const orderPrefix = kajotaOrderId.slice(0, 24).padEnd(30, "0"); // 15 bytes
const flagHex = verifiedFlag.toString(16).padStart(2, "0"); // 1 byte

const out = "0x" + depositPrefix + orderPrefix + flagHex;
if (out.length !== 66) {
  throw new Error(`Packed length is wrong: ${out.length} (expected 66)`);
}

return Functions.encodeUint256(BigInt(out));
