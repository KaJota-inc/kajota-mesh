import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress } from "viem";

/**
 * Unit tests for CosellEscrow + CosellRegistry integration.
 *
 * Covers:
 *   - deposit flow (USDC pulled from buyer, depositId returned)
 *   - confirmReceipt: buyer-signed trustless release (the happy path)
 *   - operator release: gated by RELEASE_GRACE + Pending + not-paused
 *   - dispute → freezes operator release; arbiter resolveDispute
 *   - refund (after REFUND_DELAY, from Pending or Disputed, buyer only)
 *   - hardening: owner-only role rotation, pause circuit-breaker
 *   - reverts across every path.
 *
 * MockUSDC is a 6-decimal ERC20 mirroring real Circle USDC so the
 * split math is tested against the right base-unit ratio.
 */
describe("CosellEscrow", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [wholesaler, coseller, buyer, releaseAuth, attacker, arbiter, owner] =
    await viem.getWalletClients();

  const same = (a: string, b: string) =>
    assert.equal(getAddress(a), getAddress(b));

  const advanceTime = async (seconds: number) => {
    await publicClient.transport.request({
      method: "evm_increaseTime",
      params: [seconds],
    });
    await publicClient.transport.request({ method: "evm_mine", params: [] });
  };

  const RELEASE_GRACE = 2 * 24 * 60 * 60; // 2 days
  const REFUND_DELAY = 14 * 24 * 60 * 60; // 14 days

  /** Deploy a fresh stack: registry, MockUSDC, escrow. */
  const deployStack = async (commissionBps = 1500n) => {
    const registry = await viem.deployContract("CosellRegistry");
    const usdc = await viem.deployContract("MockUSDC");
    const escrow = await viem.deployContract("CosellEscrow", [
      usdc.address,
      registry.address,
      releaseAuth.account.address,
      arbiter.account.address,
      owner.account.address,
    ]);

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

    const fund = 100_000_000n; // 100 USDC headroom
    await usdc.write.mint([buyer.account.address, fund]);

    return { registry, usdc, escrow, listingId, productId, fund };
  };

  /** Deploy + deposit; return depositId via event read. */
  const setupDeposit = async (gross = 5_000_000n, commissionBps = 1500n) => {
    const stack = await deployStack(commissionBps);
    await stack.usdc.write.approve([stack.escrow.address, gross], {
      account: buyer.account,
    });
    await stack.escrow.write.deposit([stack.listingId, gross], {
      account: buyer.account,
    });
    const events = await stack.escrow.getEvents.Deposited({}, { fromBlock: 0n });
    return { ...stack, depositId: events[0]!.args.depositId!, gross };
  };

  // ----------------------------------------------------------------
  //  deposit()
  // ----------------------------------------------------------------

  describe("deposit", () => {
    it("pulls USDC from buyer and records an Escrowed entry", async () => {
      const { usdc, escrow, listingId } = await deployStack();
      const gross = 5_000_000n;
      await usdc.write.approve([escrow.address, gross], {
        account: buyer.account,
      });
      const txHash = await escrow.write.deposit([listingId, gross], {
        account: buyer.account,
      });
      assert.ok(txHash);
      assert.equal(await usdc.read.balanceOf([escrow.address]), gross);
      assert.equal(
        await usdc.read.balanceOf([buyer.account.address]),
        100_000_000n - gross,
      );
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
        escrow.write.deposit([listingId, 1_000_000n], { account: buyer.account }),
        /ListingNotActive/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  confirmReceipt() — the trustless buyer-signed release
  // ----------------------------------------------------------------

  describe("confirmReceipt", () => {
    it("buyer releases the split immediately, no grace, no operator", async () => {
      const { usdc, escrow, depositId } = await setupDeposit();
      const wBefore = await usdc.read.balanceOf([wholesaler.account.address]);
      const cBefore = await usdc.read.balanceOf([coseller.account.address]);

      await escrow.write.confirmReceipt([depositId], { account: buyer.account });

      const wAfter = await usdc.read.balanceOf([wholesaler.account.address]);
      const cAfter = await usdc.read.balanceOf([coseller.account.address]);
      assert.equal(cAfter - cBefore, 750_000n); // 15% of 5 USDC
      assert.equal(wAfter - wBefore, 4_250_000n);
      assert.equal(await usdc.read.balanceOf([escrow.address]), 0n);
    });

    it("emits ReleaseTriggered(BuyerConfirmed)", async () => {
      const { escrow, depositId } = await setupDeposit();
      await escrow.write.confirmReceipt([depositId], { account: buyer.account });
      const evs = await escrow.getEvents.ReleaseTriggered({}, { fromBlock: 0n });
      assert.equal(evs.length, 1);
      assert.equal(evs[0]!.args.trigger, 0); // ReleaseTrigger.BuyerConfirmed
    });

    it("reverts NotBuyer when a non-buyer confirms", async () => {
      const { escrow, depositId } = await setupDeposit();
      await assert.rejects(
        escrow.write.confirmReceipt([depositId], { account: attacker.account }),
        /NotBuyer/,
      );
    });

    it("reverts DepositNotPending on double-confirm", async () => {
      const { escrow, depositId } = await setupDeposit();
      await escrow.write.confirmReceipt([depositId], { account: buyer.account });
      await assert.rejects(
        escrow.write.confirmReceipt([depositId], { account: buyer.account }),
        /DepositNotPending/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  release() — operator path (grace-gated, Pending-only, pausable)
  // ----------------------------------------------------------------

  describe("release (operator)", () => {
    it("reverts ReleaseTooEarly before RELEASE_GRACE", async () => {
      const { escrow, depositId } = await setupDeposit();
      await assert.rejects(
        escrow.write.release([depositId], { account: releaseAuth.account }),
        /ReleaseTooEarly/,
      );
    });

    it("splits 15% / 85% after the grace window", async () => {
      const { usdc, escrow, depositId } = await setupDeposit();
      const wBefore = await usdc.read.balanceOf([wholesaler.account.address]);
      const cBefore = await usdc.read.balanceOf([coseller.account.address]);

      await advanceTime(RELEASE_GRACE + 1);
      await escrow.write.release([depositId], { account: releaseAuth.account });

      const wAfter = await usdc.read.balanceOf([wholesaler.account.address]);
      const cAfter = await usdc.read.balanceOf([coseller.account.address]);
      assert.equal(cAfter - cBefore, 750_000n);
      assert.equal(wAfter - wBefore, 4_250_000n);
      assert.equal(await usdc.read.balanceOf([escrow.address]), 0n);
    });

    it("reverts NotReleaseAuth when an attacker calls", async () => {
      const { escrow, depositId } = await setupDeposit();
      await advanceTime(RELEASE_GRACE + 1);
      await assert.rejects(
        escrow.write.release([depositId], { account: attacker.account }),
        /NotReleaseAuth/,
      );
    });

    it("reverts DepositNotPending on double-release", async () => {
      const { escrow, depositId } = await setupDeposit();
      await advanceTime(RELEASE_GRACE + 1);
      await escrow.write.release([depositId], { account: releaseAuth.account });
      await assert.rejects(
        escrow.write.release([depositId], { account: releaseAuth.account }),
        /DepositNotPending/,
      );
    });

    it("handles the 50% max commission cap", async () => {
      const { usdc, escrow, depositId } = await setupDeposit(10_000_000n, 5000n);
      await advanceTime(RELEASE_GRACE + 1);
      await escrow.write.release([depositId], { account: releaseAuth.account });
      assert.equal(
        await usdc.read.balanceOf([wholesaler.account.address]),
        5_000_000n,
      );
      assert.equal(
        await usdc.read.balanceOf([coseller.account.address]),
        5_000_000n,
      );
    });

    it("reverts EnforcedPause while paused", async () => {
      const { escrow, depositId } = await setupDeposit();
      await advanceTime(RELEASE_GRACE + 1);
      await escrow.write.pause({ account: owner.account });
      await assert.rejects(
        escrow.write.release([depositId], { account: releaseAuth.account }),
        /EnforcedPause/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  dispute() + resolveDispute()
  // ----------------------------------------------------------------

  describe("dispute", () => {
    it("buyer dispute freezes the operator release path", async () => {
      const { escrow, depositId } = await setupDeposit();
      await escrow.write.dispute([depositId], { account: buyer.account });

      // Even past the grace window, operator can no longer release.
      await advanceTime(RELEASE_GRACE + 1);
      await assert.rejects(
        escrow.write.release([depositId], { account: releaseAuth.account }),
        /DepositNotPending/,
      );
    });

    it("reverts NotBuyer when a non-buyer disputes", async () => {
      const { escrow, depositId } = await setupDeposit();
      await assert.rejects(
        escrow.write.dispute([depositId], { account: attacker.account }),
        /NotBuyer/,
      );
    });

    it("buyer can still confirmReceipt out of a dispute", async () => {
      const { usdc, escrow, depositId } = await setupDeposit();
      await escrow.write.dispute([depositId], { account: buyer.account });
      await escrow.write.confirmReceipt([depositId], { account: buyer.account });
      assert.equal(await usdc.read.balanceOf([escrow.address]), 0n);
    });
  });

  describe("resolveDispute", () => {
    const disputed = async () => {
      const s = await setupDeposit();
      await s.escrow.write.dispute([s.depositId], { account: buyer.account });
      return s;
    };

    it("arbiter releases the split to the seller", async () => {
      const { usdc, escrow, depositId } = await disputed();
      const cBefore = await usdc.read.balanceOf([coseller.account.address]);
      await escrow.write.resolveDispute([depositId, true], {
        account: arbiter.account,
      });
      assert.equal(
        (await usdc.read.balanceOf([coseller.account.address])) - cBefore,
        750_000n,
      );
      assert.equal(await usdc.read.balanceOf([escrow.address]), 0n);
    });

    it("arbiter refunds the buyer in full", async () => {
      const { usdc, escrow, depositId, gross } = await disputed();
      const bBefore = await usdc.read.balanceOf([buyer.account.address]);
      await escrow.write.resolveDispute([depositId, false], {
        account: arbiter.account,
      });
      assert.equal(
        (await usdc.read.balanceOf([buyer.account.address])) - bBefore,
        gross,
      );
    });

    it("reverts NotArbiter for a non-arbiter (incl. releaseAuth)", async () => {
      const { escrow, depositId } = await disputed();
      await assert.rejects(
        escrow.write.resolveDispute([depositId, true], {
          account: releaseAuth.account,
        }),
        /NotArbiter/,
      );
    });

    it("reverts DepositNotDisputed when not disputed", async () => {
      const { escrow, depositId } = await setupDeposit();
      await assert.rejects(
        escrow.write.resolveDispute([depositId, true], {
          account: arbiter.account,
        }),
        /DepositNotDisputed/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  refund()
  // ----------------------------------------------------------------

  describe("refund", () => {
    it("reverts RefundTooEarly before REFUND_DELAY", async () => {
      const { escrow, depositId } = await setupDeposit(3_000_000n);
      await assert.rejects(
        escrow.write.refund([depositId], { account: buyer.account }),
        /RefundTooEarly/,
      );
    });

    it("refunds full gross to buyer after 14 days", async () => {
      const { usdc, escrow, depositId, gross } = await setupDeposit(3_000_000n);
      const before = await usdc.read.balanceOf([buyer.account.address]);
      await advanceTime(REFUND_DELAY + 1);
      await escrow.write.refund([depositId], { account: buyer.account });
      assert.equal(
        (await usdc.read.balanceOf([buyer.account.address])) - before,
        gross,
      );
    });

    it("refunds from a Disputed deposit too (no indefinite lock)", async () => {
      const { usdc, escrow, depositId, gross } = await setupDeposit(3_000_000n);
      await escrow.write.dispute([depositId], { account: buyer.account });
      const before = await usdc.read.balanceOf([buyer.account.address]);
      await advanceTime(REFUND_DELAY + 1);
      await escrow.write.refund([depositId], { account: buyer.account });
      assert.equal(
        (await usdc.read.balanceOf([buyer.account.address])) - before,
        gross,
      );
    });

    it("reverts NotBuyer when a non-buyer tries to refund", async () => {
      const { escrow, depositId } = await setupDeposit(3_000_000n);
      await advanceTime(REFUND_DELAY + 1);
      await assert.rejects(
        escrow.write.refund([depositId], { account: attacker.account }),
        /NotBuyer/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  hardening: role rotation + pause
  // ----------------------------------------------------------------

  describe("admin / hardening", () => {
    it("only owner can rotate releaseAuth — operator can NOT rotate itself", async () => {
      const { escrow } = await deployStack();
      // operator can no longer rotate itself (the old footgun)
      await assert.rejects(
        escrow.write.setReleaseAuth([attacker.account.address], {
          account: releaseAuth.account,
        }),
        /OwnableUnauthorizedAccount/,
      );
      // attacker can't either
      await assert.rejects(
        escrow.write.setReleaseAuth([attacker.account.address], {
          account: attacker.account,
        }),
        /OwnableUnauthorizedAccount/,
      );
      // owner can
      await escrow.write.setReleaseAuth([attacker.account.address], {
        account: owner.account,
      });
      same(await escrow.read.releaseAuth(), attacker.account.address);
    });

    it("only owner can rotate the arbiter", async () => {
      const { escrow } = await deployStack();
      await assert.rejects(
        escrow.write.setArbiter([attacker.account.address], {
          account: attacker.account,
        }),
        /OwnableUnauthorizedAccount/,
      );
      await escrow.write.setArbiter([wholesaler.account.address], {
        account: owner.account,
      });
      same(await escrow.read.arbiter(), wholesaler.account.address);
    });

    it("pause blocks deposit; buyer confirmReceipt still works", async () => {
      const { escrow, depositId } = await setupDeposit();
      await escrow.write.pause({ account: owner.account });

      // new deposits blocked
      await assert.rejects(
        escrow.write.deposit([depositId, 1_000_000n], { account: buyer.account }),
        /EnforcedPause/,
      );
      // but the buyer's own confirm still settles (buyer protection stays live)
      await escrow.write.confirmReceipt([depositId], { account: buyer.account });
    });

    it("only owner can pause", async () => {
      const { escrow } = await deployStack();
      await assert.rejects(
        escrow.write.pause({ account: attacker.account }),
        /OwnableUnauthorizedAccount/,
      );
    });
  });
});
