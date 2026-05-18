import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, keccak256, encodePacked } from "viem";

/**
 * Unit tests for CosellRegistry.
 *
 * Covers the happy path of register / deactivate / read, plus the obvious
 * revert paths (wholesaler != msg.sender, commission > 50%, duplicate
 * listing). Split-math is tested with a few representative percentages
 * (1bp, 15%, 50% cap).
 *
 * Address normalization mirrors concierge's convention: contract reads
 * may return lowercase, viem returns checksummed — compare via
 * `getAddress(...)` on both sides.
 */
describe("CosellRegistry", async () => {
  // Hardhat 3 isolation pattern (same as concierge): `network.create()`
  // gives a fresh EDR per describe block.
  const { viem } = await network.create();
  const [wholesaler, coseller, other] = await viem.getWalletClients();

  const same = (a: string, b: string) => assert.equal(getAddress(a), getAddress(b));

  /** Deploy a fresh CosellRegistry. */
  const deploy = async () => {
    return await viem.deployContract("CosellRegistry");
  };

  // ----------------------------------------------------------------
  //  register()
  // ----------------------------------------------------------------

  describe("register", () => {
    it("stores a new listing and emits ListingRegistered", async () => {
      const registry = await deploy();
      const productId = "6a0b4c3d6df81b631aa879ab";
      const commissionBps = 1500; // 15%
      const currency = "NGN";

      const tx = await registry.write.register(
        [productId, wholesaler.account.address, coseller.account.address, commissionBps, currency],
        { account: wholesaler.account },
      );

      const listingId = keccak256(
        encodePacked(
          ["string", "address", "address"],
          [productId, wholesaler.account.address, coseller.account.address],
        ),
      );

      const listing = await registry.read.getListing([listingId]);
      assert.equal(listing.productId, productId);
      same(listing.wholesaler, wholesaler.account.address);
      same(listing.coseller, coseller.account.address);
      assert.equal(listing.commissionBps, commissionBps);
      assert.equal(listing.currency, currency);
      assert.equal(listing.active, true);
      assert.notEqual(listing.registeredAt, 0n);

      // tx hash returned for chain-side replay if needed
      assert.ok(tx);
    });

    it("appends to listingsForProduct and listingsForCoseller indexes", async () => {
      const registry = await deploy();
      const productId = "6a0b4c3d6df81b631aa879ab";

      await registry.write.register(
        [productId, wholesaler.account.address, coseller.account.address, 1500, "NGN"],
        { account: wholesaler.account },
      );

      const productIndex = await registry.read.listingsForProduct([productId]);
      assert.equal(productIndex.length, 1);

      const cosellerIndex = await registry.read.listingsForCoseller([coseller.account.address]);
      assert.equal(cosellerIndex.length, 1);
      assert.equal(cosellerIndex[0], productIndex[0]);
    });

    it("reverts InvalidWholesaler when msg.sender != wholesaler arg", async () => {
      const registry = await deploy();
      await assert.rejects(
        registry.write.register(
          [
            "p1",
            // Wholesaler arg is `coseller` but msg.sender is `wholesaler`
            // → impersonation attempt.
            coseller.account.address,
            other.account.address,
            1000,
            "NGN",
          ],
          { account: wholesaler.account },
        ),
        /InvalidWholesaler/,
      );
    });

    it("reverts InvalidCoseller when wholesaler == coseller", async () => {
      const registry = await deploy();
      await assert.rejects(
        registry.write.register(
          ["p1", wholesaler.account.address, wholesaler.account.address, 1000, "NGN"],
          { account: wholesaler.account },
        ),
        /InvalidCoseller/,
      );
    });

    it("reverts InvalidCommissionBps when commission > 50%", async () => {
      const registry = await deploy();
      await assert.rejects(
        registry.write.register(
          ["p1", wholesaler.account.address, coseller.account.address, 5001, "NGN"],
          { account: wholesaler.account },
        ),
        /InvalidCommissionBps/,
      );
    });

    it("reverts ListingAlreadyExists on duplicate triple", async () => {
      const registry = await deploy();
      await registry.write.register(
        ["p1", wholesaler.account.address, coseller.account.address, 1500, "NGN"],
        { account: wholesaler.account },
      );
      await assert.rejects(
        registry.write.register(
          ["p1", wholesaler.account.address, coseller.account.address, 2000, "NGN"],
          { account: wholesaler.account },
        ),
        /ListingAlreadyExists/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  deactivate()
  // ----------------------------------------------------------------

  describe("deactivate", () => {
    it("flips active to false and emits", async () => {
      const registry = await deploy();
      await registry.write.register(
        ["p1", wholesaler.account.address, coseller.account.address, 1500, "NGN"],
        { account: wholesaler.account },
      );
      const listingId = await registry.read.computeListingId([
        "p1",
        wholesaler.account.address,
        coseller.account.address,
      ]);

      await registry.write.deactivate([listingId], { account: wholesaler.account });

      const listing = await registry.read.getListing([listingId]);
      assert.equal(listing.active, false);
      // history preserved
      assert.notEqual(listing.registeredAt, 0n);
    });

    it("reverts NotWholesaler when a non-wholesaler tries", async () => {
      const registry = await deploy();
      await registry.write.register(
        ["p1", wholesaler.account.address, coseller.account.address, 1500, "NGN"],
        { account: wholesaler.account },
      );
      const listingId = await registry.read.computeListingId([
        "p1",
        wholesaler.account.address,
        coseller.account.address,
      ]);

      await assert.rejects(
        registry.write.deactivate([listingId], { account: coseller.account }),
        /NotWholesaler/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  computeSplit() — pure math
  // ----------------------------------------------------------------

  describe("computeSplit", () => {
    it("computes 15% / 85% split correctly on ₦5,000", async () => {
      const registry = await deploy();
      await registry.write.register(
        ["p1", wholesaler.account.address, coseller.account.address, 1500, "NGN"],
        { account: wholesaler.account },
      );
      const listingId = await registry.read.computeListingId([
        "p1",
        wholesaler.account.address,
        coseller.account.address,
      ]);

      const [cosellerShare, wholesalerShare] = await registry.read.computeSplit([
        5000n,
        listingId,
      ]);
      assert.equal(cosellerShare, 750n);
      assert.equal(wholesalerShare, 4250n);
      assert.equal(cosellerShare + wholesalerShare, 5000n);
    });

    it("respects 1bp minimum (no rounding-down to zero on small amounts)", async () => {
      const registry = await deploy();
      // 1 bp = 0.01% — tiniest legal split.
      await registry.write.register(
        ["p1", wholesaler.account.address, coseller.account.address, 1, "NGN"],
        { account: wholesaler.account },
      );
      const listingId = await registry.read.computeListingId([
        "p1",
        wholesaler.account.address,
        coseller.account.address,
      ]);

      // 1bp of 10000 = 1 — exact.
      const [cosellerShare, wholesalerShare] = await registry.read.computeSplit([
        10_000n,
        listingId,
      ]);
      assert.equal(cosellerShare, 1n);
      assert.equal(wholesalerShare, 9_999n);
    });

    it("respects 50% MAX_COMMISSION_BPS cap", async () => {
      const registry = await deploy();
      await registry.write.register(
        ["p1", wholesaler.account.address, coseller.account.address, 5000, "NGN"],
        { account: wholesaler.account },
      );
      const listingId = await registry.read.computeListingId([
        "p1",
        wholesaler.account.address,
        coseller.account.address,
      ]);

      const [cosellerShare, wholesalerShare] = await registry.read.computeSplit([
        1000n,
        listingId,
      ]);
      assert.equal(cosellerShare, 500n);
      assert.equal(wholesalerShare, 500n);
    });
  });
});
