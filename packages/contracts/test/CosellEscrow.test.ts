import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress } from "viem";

/**
 * Unit tests for CosellEscrow + CosellRegistry integration.
 *
 * Covers:
 *   - deposit flow (USDC pulled from buyer, depositId returned)
 *   - release flow (split by commissionBps, both transfers atomic)
 *   - refund flow (only after REFUND_DELAY, only by buyer)
 *   - reverts: wrong caller, wrong state, inactive listing,
 *     zero amount, refund-too-early.
 *
 * MockUSDC is a 6-decimal ERC20 mirroring real Circle USDC so the
 * split math is tested against the right base-unit ratio (a 15%
 * split of 5 USDC is 750_000 / 4_250_000 base units, not 750 / 4250).
 */
describe("CosellEscrow", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wholesaler, coseller, buyer, releaseAuth, attacker] =
    await viem.getWalletClients();

  const same = (a: string, b: string) =>
    assert.equal(getAddress(a), getAddress(b));

  /** Deploy a fresh stack: registry, MockUSDC, escrow. */
  const deployStack = async (commissionBps = 1500n) => {
    const registry = await viem.deployContract("CosellRegistry");
    const usdc = await viem.deployContract("MockUSDC");
    const escrow = await viem.deployContract("CosellEscrow", [
      usdc.address,
      registry.address,
      releaseAuth.account.address,
    ]);

    // Register a listing: 15% commission on a sample product.
    const productId = "6a0b4c3d6df81b631aa879ab";
    await registry.write.register(
      [
        productId,
        wholesaler.account.address,
        coseller.account.address,
        Number(commissionBps),
        "USDC",
      ],
      { account: wholesaler.account },
    );
    const listingId = await registry.read.computeListingId([
      productId,
      wholesaler.account.address,
      coseller.account.address,
    ]);

    // Fund the buyer with mock USDC (5 USDC = 5_000_000 base units).
    const fund = 100_000_000n; // 100 USDC headroom
    await usdc.write.mint([buyer.account.address, fund]);

    return { registry, usdc, escrow, listingId, productId, fund };
  };

  // ----------------------------------------------------------------
  //  deposit()
  // ----------------------------------------------------------------

  describe("deposit", () => {
    it("pulls USDC from buyer and records an Escrowed entry", async () => {
      const { usdc, escrow, listingId } = await deployStack();
      const gross = 5_000_000n; // 5 USDC

      await usdc.write.approve([escrow.address, gross], {
        account: buyer.account,
      });

      const txHash = await escrow.write.deposit([listingId, gross], {
        account: buyer.account,
      });
      assert.ok(txHash);

      const escrowBalance = await usdc.read.balanceOf([escrow.address]);
      assert.equal(escrowBalance, gross);

      const buyerBalance = await usdc.read.balanceOf([buyer.account.address]);
      assert.equal(buyerBalance, 100_000_000n - gross);
    });

    it("emits Deposited with the right buyer + amount", async () => {
      const { usdc, escrow, listingId } = await deployStack();
      const gross = 5_000_000n;
      await usdc.write.approve([escrow.address, gross], {
        account: buyer.account,
      });

      const txHash = await escrow.write.deposit([listingId, gross], {
        account: buyer.account,
      });

      const events = await escrow.getEvents.Deposited({}, { fromBlock: 0n });
      assert.equal(events.length, 1);
      const e = events[0]!;
      assert.equal(e.args.listingId, listingId);
      same(e.args.buyer!, buyer.account.address);
      assert.equal(e.args.grossAmount, gross);
    });

    it("reverts ZeroAmount on grossAmount = 0", async () => {
      const { escrow, listingId } = await deployStack();
      await assert.rejects(
        escrow.write.deposit([listingId, 0n], { account: buyer.account }),
        /ZeroAmount/,
      );
    });

    it("reverts ListingNotActive after wholesaler deactivates", async () => {
      const { registry, escrow, listingId } = await deployStack();
      await registry.write.deactivate([listingId], {
        account: wholesaler.account,
      });
      await assert.rejects(
        escrow.write.deposit([listingId, 1_000_000n], {
          account: buyer.account,
        }),
        /ListingNotActive/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  release()
  // ----------------------------------------------------------------

  describe("release", () => {
    /** Deploy + deposit; return depositId via event read. */
    const setupDeposit = async (gross = 5_000_000n, commissionBps = 1500n) => {
      const stack = await deployStack(commissionBps);
      await stack.usdc.write.approve([stack.escrow.address, gross], {
        account: buyer.account,
      });
      await stack.escrow.write.deposit([stack.listingId, gross], {
        account: buyer.account,
      });
      const events = await stack.escrow.getEvents.Deposited(
        {},
        { fromBlock: 0n },
      );
      return { ...stack, depositId: events[0]!.args.depositId!, gross };
    };

    it("splits 15% / 85% to coseller / wholesaler", async () => {
      const { usdc, escrow, depositId } = await setupDeposit();

      const wholesalerBefore = await usdc.read.balanceOf([
        wholesaler.account.address,
      ]);
      const cosellerBefore = await usdc.read.balanceOf([
        coseller.account.address,
      ]);

      await escrow.write.release([depositId], {
        account: releaseAuth.account,
      });

      const wholesalerAfter = await usdc.read.balanceOf([
        wholesaler.account.address,
      ]);
      const cosellerAfter = await usdc.read.balanceOf([
        coseller.account.address,
      ]);

      // 15% of 5_000_000 = 750_000
      assert.equal(cosellerAfter - cosellerBefore, 750_000n);
      assert.equal(wholesalerAfter - wholesalerBefore, 4_250_000n);

      // Escrow drained back to 0
      const escrowBalance = await usdc.read.balanceOf([escrow.address]);
      assert.equal(escrowBalance, 0n);
    });

    it("reverts NotReleaseAuth when an attacker calls", async () => {
      const { escrow, depositId } = await setupDeposit();
      await assert.rejects(
        escrow.write.release([depositId], { account: attacker.account }),
        /NotReleaseAuth/,
      );
    });

    it("reverts DepositNotPending on double-release", async () => {
      const { escrow, depositId } = await setupDeposit();
      await escrow.write.release([depositId], {
        account: releaseAuth.account,
      });
      await assert.rejects(
        escrow.write.release([depositId], {
          account: releaseAuth.account,
        }),
        /DepositNotPending/,
      );
    });

    it("handles 50% max commission cap correctly", async () => {
      const { usdc, escrow, depositId } = await setupDeposit(
        10_000_000n,
        5000n,
      );
      await escrow.write.release([depositId], {
        account: releaseAuth.account,
      });
      const wholesalerBal = await usdc.read.balanceOf([
        wholesaler.account.address,
      ]);
      const cosellerBal = await usdc.read.balanceOf([
        coseller.account.address,
      ]);
      // Each gets 5 USDC out of 10.
      assert.equal(wholesalerBal, 5_000_000n);
      assert.equal(cosellerBal, 5_000_000n);
    });
  });

  // ----------------------------------------------------------------
  //  refund()
  // ----------------------------------------------------------------

  describe("refund", () => {
    it("reverts RefundTooEarly before REFUND_DELAY elapses", async () => {
      const { usdc, escrow, listingId } = await deployStack();
      const gross = 3_000_000n;
      await usdc.write.approve([escrow.address, gross], {
        account: buyer.account,
      });
      await escrow.write.deposit([listingId, gross], {
        account: buyer.account,
      });
      const events = await escrow.getEvents.Deposited({}, { fromBlock: 0n });
      const depositId = events[0]!.args.depositId!;

      await assert.rejects(
        escrow.write.refund([depositId], { account: buyer.account }),
        /RefundTooEarly/,
      );
    });

    it("allows refund after 14 days, returns full gross to buyer", async () => {
      const { usdc, escrow, listingId } = await deployStack();
      const gross = 3_000_000n;
      await usdc.write.approve([escrow.address, gross], {
        account: buyer.account,
      });
      await escrow.write.deposit([listingId, gross], {
        account: buyer.account,
      });
      const events = await escrow.getEvents.Deposited({}, { fromBlock: 0n });
      const depositId = events[0]!.args.depositId!;

      const buyerBalBefore = await usdc.read.balanceOf([
        buyer.account.address,
      ]);

      // Advance chain time past the 14-day window.
      const FOURTEEN_DAYS = 14 * 24 * 60 * 60 + 1;
      await publicClient.transport.request({
        method: "evm_increaseTime",
        params: [FOURTEEN_DAYS],
      });
      await publicClient.transport.request({
        method: "evm_mine",
        params: [],
      });

      await escrow.write.refund([depositId], { account: buyer.account });

      const buyerBalAfter = await usdc.read.balanceOf([buyer.account.address]);
      assert.equal(buyerBalAfter - buyerBalBefore, gross);
    });

    it("reverts NotBuyer when a non-buyer tries to refund", async () => {
      const { usdc, escrow, listingId } = await deployStack();
      const gross = 3_000_000n;
      await usdc.write.approve([escrow.address, gross], {
        account: buyer.account,
      });
      await escrow.write.deposit([listingId, gross], {
        account: buyer.account,
      });
      const events = await escrow.getEvents.Deposited({}, { fromBlock: 0n });
      const depositId = events[0]!.args.depositId!;

      const FOURTEEN_DAYS = 14 * 24 * 60 * 60 + 1;
      await publicClient.transport.request({
        method: "evm_increaseTime",
        params: [FOURTEEN_DAYS],
      });
      await publicClient.transport.request({
        method: "evm_mine",
        params: [],
      });

      await assert.rejects(
        escrow.write.refund([depositId], { account: attacker.account }),
        /NotBuyer/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  setReleaseAuth()
  // ----------------------------------------------------------------

  describe("setReleaseAuth", () => {
    it("only current releaseAuth can rotate", async () => {
      const { escrow } = await deployStack();
      await assert.rejects(
        escrow.write.setReleaseAuth([attacker.account.address], {
          account: attacker.account,
        }),
        /NotReleaseAuth/,
      );

      await escrow.write.setReleaseAuth([attacker.account.address], {
        account: releaseAuth.account,
      });
      same(await escrow.read.releaseAuth(), attacker.account.address);
    });
  });
});
