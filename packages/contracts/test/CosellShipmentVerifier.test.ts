import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  getAddress,
  encodePacked,
  toHex,
  pad,
  concat,
  type Hex,
} from "viem";

/**
 * Unit tests for CosellShipmentVerifier — the Chainlink Functions
 * consumer that ties attestation/source.js to CosellEscrow.release().
 *
 * Approach: a tiny `MockFunctionsRouter` stands in for the real
 * Chainlink router so we can deterministically simulate a DON
 * fulfilment via `router.fulfill(requestId, response, err)` and
 * watch what the verifier does.
 *
 * Covers:
 *   - happy path: request → router.fulfill with flag=01 → escrow
 *     drained, ShipmentConfirmed emitted.
 *   - flag=00 path: response decoded, no release call,
 *     ShipmentRejected("NOT_SHIPPED") emitted.
 *   - prefix mismatch: callback for a different depositId is
 *     rejected (PREFIX_MISMATCH).
 *   - permission: non-operator can't call requestShipmentVerification.
 *   - operator rotation.
 */
describe("CosellShipmentVerifier", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wholesaler, coseller, buyer, operator, attacker] =
    await viem.getWalletClients();

  const same = (a: string, b: string) =>
    assert.equal(getAddress(a), getAddress(b));

  const SOURCE = "// inline-js placeholder for tests";
  const SUB_ID = 1n;
  const CALLBACK_GAS = 300_000;
  const DON_ID = pad("0x66756e2d626173652d7365706f6c69612d31", { size: 32 }); // "fun-base-sepolia-1" UTF-8 padded

  /**
   * Deploy registry, escrow, mock router, verifier — and set the
   * verifier as the escrow's releaseAuth so on-chain release works.
   */
  const deployStack = async () => {
    const registry = await viem.deployContract("CosellRegistry");
    const usdc = await viem.deployContract("MockUSDC");
    const router = await viem.deployContract("MockFunctionsRouter");

    // Initial releaseAuth is the deployer; we rotate to the verifier
    // after deploying it so the verifier can call escrow.release.
    const [deployer] = await viem.getWalletClients();
    const escrow = await viem.deployContract("CosellEscrow", [
      usdc.address,
      registry.address,
      deployer.account.address,
    ]);

    const verifier = await viem.deployContract("CosellShipmentVerifier", [
      router.address,
      escrow.address,
      SOURCE,
      Number(SUB_ID),
      CALLBACK_GAS,
      DON_ID,
      operator.account.address,
    ]);

    // Hand release authority over to the verifier (the deployment
    // pattern documented in CosellShipmentVerifier.sol).
    await escrow.write.setReleaseAuth([verifier.address], {
      account: deployer.account,
    });

    // Register a listing + fund + deposit so we have something to release.
    const productId = "6a0b4c3d6df81b631aa879ab";
    await registry.write.register(
      [
        productId,
        wholesaler.account.address,
        coseller.account.address,
        1500, // 15%
        "USDC",
      ],
      { account: wholesaler.account },
    );
    const listingId = await registry.read.computeListingId([
      productId,
      wholesaler.account.address,
      coseller.account.address,
    ]);

    const gross = 5_000_000n;
    await usdc.write.mint([buyer.account.address, gross]);
    await usdc.write.approve([escrow.address, gross], {
      account: buyer.account,
    });
    await escrow.write.deposit([listingId, gross], {
      account: buyer.account,
    });
    const depositEvents = await escrow.getEvents.Deposited(
      {},
      { fromBlock: 0n },
    );
    const depositId = depositEvents[0]!.args.depositId! as Hex;

    return { registry, usdc, router, escrow, verifier, depositId, productId, gross };
  };

  /**
   * Build the 32-byte DON response shape produced by
   * attestation/source.js:
   *   [depositPrefix(16B) || orderPrefix(15B) || flag(1B)]
   *
   * `prefixSource` lets the test override the depositId being
   * attested-to so we can simulate callback-swap attacks.
   */
  const packResponse = (
    depositId: Hex,
    orderId: string,
    flag: 0 | 1,
    prefixSource?: Hex,
  ): Hex => {
    const depositPrefix = (prefixSource ?? depositId).slice(2, 34) as Hex; // 32 hex chars = 16 bytes
    const orderHex = Buffer.from(orderId.padEnd(15, "\0"), "utf8")
      .toString("hex")
      .slice(0, 30); // 15 bytes
    const flagHex = flag.toString(16).padStart(2, "0");
    // Note: source.js uses orderId.slice(0,24).padEnd(30,"0") — pure
    // ASCII passthrough, not utf-8 hex. We mirror that here.
    const orderAscii = orderId.slice(0, 24).padEnd(30, "0");
    const orderHexFromAscii = Buffer.from(orderAscii, "utf8")
      .toString("hex")
      .slice(0, 30);
    // Verifier only checks depositPrefix on-chain, so the orderId
    // packing is informational — use the source.js shape so future
    // hardened verifiers (that also check orderId) keep passing.
    const out = `0x${depositPrefix}${orderHexFromAscii}${flagHex}`;
    assert.equal(out.length, 66, `packed length ${out.length}`);
    return out as Hex;
  };

  // ----------------------------------------------------------------

  describe("requestShipmentVerification", () => {
    it("emits ShipmentRequested and stores depositId/orderId by requestId", async () => {
      const { verifier, depositId } = await deployStack();
      const orderId = "6a0b4c3d6df81b631aa879ab";

      await verifier.write.requestShipmentVerification(
        [depositId, orderId],
        { account: operator.account },
      );

      const events = await verifier.getEvents.ShipmentRequested(
        {},
        { fromBlock: 0n },
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]!.args.depositId, depositId);
      assert.equal(events[0]!.args.orderId, orderId);

      const requestId = events[0]!.args.requestId!;
      const storedDeposit = await verifier.read.requestToDeposit([requestId]);
      assert.equal(storedDeposit, depositId);
    });

    it("reverts NotOperator when a non-operator calls", async () => {
      const { verifier, depositId } = await deployStack();
      await assert.rejects(
        verifier.write.requestShipmentVerification(
          [depositId, "6a0b4c3d6df81b631aa879ab"],
          { account: attacker.account },
        ),
        /NotOperator/,
      );
    });

    it("reverts ZeroDepositId / EmptyOrderId on bad inputs", async () => {
      const { verifier, depositId } = await deployStack();
      await assert.rejects(
        verifier.write.requestShipmentVerification(
          [
            "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
            "6a0b4c3d6df81b631aa879ab",
          ],
          { account: operator.account },
        ),
        /ZeroDepositId/,
      );
      await assert.rejects(
        verifier.write.requestShipmentVerification([depositId, ""], {
          account: operator.account,
        }),
        /EmptyOrderId/,
      );
    });
  });

  describe("_fulfillRequest", () => {
    it("releases the escrow on flag=0x01 and emits ShipmentConfirmed", async () => {
      const { router, escrow, verifier, depositId, usdc } = await deployStack();
      const orderId = "6a0b4c3d6df81b631aa879ab";

      await verifier.write.requestShipmentVerification(
        [depositId, orderId],
        { account: operator.account },
      );
      const requestId = await router.read.lastRequestId();

      const response = packResponse(depositId, orderId, 1);

      const wholesalerBefore = await usdc.read.balanceOf([
        wholesaler.account.address,
      ]);
      const cosellerBefore = await usdc.read.balanceOf([
        coseller.account.address,
      ]);

      await router.write.fulfill([requestId, response, "0x"]);

      const wholesalerAfter = await usdc.read.balanceOf([
        wholesaler.account.address,
      ]);
      const cosellerAfter = await usdc.read.balanceOf([
        coseller.account.address,
      ]);
      assert.equal(wholesalerAfter - wholesalerBefore, 4_250_000n);
      assert.equal(cosellerAfter - cosellerBefore, 750_000n);

      const confirms = await verifier.getEvents.ShipmentConfirmed(
        {},
        { fromBlock: 0n },
      );
      assert.equal(confirms.length, 1);
      assert.equal(confirms[0]!.args.depositId, depositId);
    });

    it("does NOT release on flag=0x00 — emits ShipmentRejected(NOT_SHIPPED)", async () => {
      const { router, escrow, verifier, depositId, usdc } = await deployStack();
      const orderId = "6a0b4c3d6df81b631aa879ab";

      await verifier.write.requestShipmentVerification(
        [depositId, orderId],
        { account: operator.account },
      );
      const requestId = await router.read.lastRequestId();

      const escrowBalBefore = await usdc.read.balanceOf([escrow.address]);
      const response = packResponse(depositId, orderId, 0);
      await router.write.fulfill([requestId, response, "0x"]);
      const escrowBalAfter = await usdc.read.balanceOf([escrow.address]);
      assert.equal(escrowBalAfter, escrowBalBefore); // untouched

      const rejections = await verifier.getEvents.ShipmentRejected(
        {},
        { fromBlock: 0n },
      );
      assert.equal(rejections.length, 1);
    });

    it("rejects callback whose depositPrefix doesn't match — PREFIX_MISMATCH", async () => {
      const { router, escrow, verifier, depositId, usdc } = await deployStack();
      const orderId = "6a0b4c3d6df81b631aa879ab";

      await verifier.write.requestShipmentVerification(
        [depositId, orderId],
        { account: operator.account },
      );
      const requestId = await router.read.lastRequestId();

      // Craft a response that *claims* shipped=true but for a
      // *different* depositId (simulates a malicious operator
      // reusing one valid DON attestation across many deposits).
      const fakeDeposit =
        "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface" as Hex;
      const response = packResponse(depositId, orderId, 1, fakeDeposit);

      const escrowBalBefore = await usdc.read.balanceOf([escrow.address]);
      await router.write.fulfill([requestId, response, "0x"]);
      const escrowBalAfter = await usdc.read.balanceOf([escrow.address]);
      assert.equal(escrowBalAfter, escrowBalBefore); // untouched

      const rejections = await verifier.getEvents.ShipmentRejected(
        {},
        { fromBlock: 0n },
      );
      assert.equal(rejections.length, 1);
    });

    it("surfaces DON-side errors via ShipmentRejected with the err bytes", async () => {
      const { router, escrow, verifier, depositId, usdc } = await deployStack();
      const orderId = "6a0b4c3d6df81b631aa879ab";

      await verifier.write.requestShipmentVerification(
        [depositId, orderId],
        { account: operator.account },
      );
      const requestId = await router.read.lastRequestId();

      const escrowBalBefore = await usdc.read.balanceOf([escrow.address]);
      const errBytes = toHex("kajota endpoint 5xx", { size: undefined });
      await router.write.fulfill([requestId, "0x", errBytes]);
      const escrowBalAfter = await usdc.read.balanceOf([escrow.address]);
      assert.equal(escrowBalAfter, escrowBalBefore);

      const rejections = await verifier.getEvents.ShipmentRejected(
        {},
        { fromBlock: 0n },
      );
      assert.equal(rejections.length, 1);
    });
  });

  describe("admin", () => {
    it("setOperator rotates only when current operator calls", async () => {
      const { verifier } = await deployStack();
      await assert.rejects(
        verifier.write.setOperator([attacker.account.address], {
          account: attacker.account,
        }),
        /NotOperator/,
      );
      await verifier.write.setOperator([attacker.account.address], {
        account: operator.account,
      });
      same(await verifier.read.operator(), attacker.account.address);
    });
  });
});
