import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress } from "viem";

/**
 * Unit tests for KajotaEscrow — the ETHGlobal NY 2026 escrow flow.
 *
 * Covers:
 *   - createAndDeposit: pulls USDC, records Escrow, returns escrowId
 *   - confirmDelivery: only buyer, atomic release to merchant
 *   - refundOnTimeout: only buyer, only after deliveryDeadline
 *   - raiseDispute: either party, flips to Disputed
 *   - resolveDispute: only resolver, push to chosen recipient
 *   - admin: setDisputeResolver gated to current resolver
 *   - reverts: zero amount, invalid merchant, wrong delivery window,
 *     wrong caller, wrong state, deadline-not-reached.
 *
 * Reuses the existing MockUSDC (6-decimal mock mirroring Circle USDC)
 * so test amounts use real USDC base units (5 USDC = 5_000_000).
 */
describe("KajotaEscrow", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [merchant, buyer, disputeResolver, attacker, otherMerchant] =
    await viem.getWalletClients();

  const same = (a: string, b: string) =>
    assert.equal(getAddress(a), getAddress(b));

  /** Deploy a fresh stack: MockUSDC + KajotaEscrow. */
  const deployStack = async () => {
    const usdc = await viem.deployContract("MockUSDC");
    const escrow = await viem.deployContract("KajotaEscrow", [
      usdc.address,
      disputeResolver.account.address,
    ]);

    // Fund the buyer with mock USDC (1000 USDC headroom).
    const fund = 1_000_000_000n; // 1000 USDC in 6-decimal base units
    await usdc.write.mint([buyer.account.address, fund]);
    return { usdc, escrow, fund };
  };

  /** Buyer approves + creates an escrow. Returns the depositId from logs. */
  const depositOnce = async (
    deps: { usdc: any; escrow: any },
    opts: { amount?: bigint; window?: bigint; merchant?: `0x${string}` } = {},
  ) => {
    const amount = opts.amount ?? 5_000_000n; // 5 USDC default
    const window = opts.window ?? 7n * 24n * 60n * 60n; // 7 days default
    const merchantAddr = opts.merchant ?? (merchant.account.address as `0x${string}`);

    await deps.usdc.write.approve([deps.escrow.address, amount], {
      account: buyer.account,
    });

    const txHash = await deps.escrow.write.createAndDeposit(
      [merchantAddr, amount, window],
      { account: buyer.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const log = receipt.logs.find(l =>
      l.topics[0] ===
      // keccak256("EscrowCreated(bytes32,address,address,address,uint256,uint64)")
      // The contract's EscrowCreated event has 3 indexed + 2 non-indexed
      // params; topics[1] is the escrowId.
      "0x" + "".padEnd(64, "0"), // placeholder — will use the parseEvent path
    );
    // Pull escrowId from the indexed topic[1] of the first log emitted
    // by the escrow contract.
    const escrowLog = receipt.logs.find(
      l => getAddress(l.address) === getAddress(deps.escrow.address),
    );
    assert.ok(escrowLog, "expected an EscrowCreated log from the escrow contract");
    const escrowId = escrowLog.topics[1] as `0x${string}`;
    return { escrowId, amount, window, merchantAddr };
  };

  // ----------------------------------------------------------------
  //  createAndDeposit()
  // ----------------------------------------------------------------

  describe("createAndDeposit", () => {
    it("pulls USDC from buyer and records an Escrow row", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId, amount } = await depositOnce({ usdc, escrow });

      // Funds moved to the escrow contract.
      const escrowBal = await usdc.read.balanceOf([escrow.address]);
      assert.equal(escrowBal, amount);

      // Escrow row exists with the right shape.
      const e = await escrow.read.getEscrow([escrowId]);
      same(e.buyer, buyer.account.address);
      same(e.merchant, merchant.account.address);
      assert.equal(e.amount, amount);
      assert.equal(e.state, 0); // State.Pending
      assert.ok(e.deliveryDeadline > e.createdAt);
    });

    it("rejects zero amount", async () => {
      const { usdc, escrow } = await deployStack();
      await usdc.write.approve([escrow.address, 1n], { account: buyer.account });
      await assert.rejects(
        escrow.write.createAndDeposit(
          [merchant.account.address, 0n, 7n * 24n * 60n * 60n],
          { account: buyer.account },
        ),
        /ZeroAmount/,
      );
    });

    it("rejects the zero merchant address", async () => {
      const { usdc, escrow } = await deployStack();
      await usdc.write.approve([escrow.address, 5_000_000n], {
        account: buyer.account,
      });
      await assert.rejects(
        escrow.write.createAndDeposit(
          [
            "0x0000000000000000000000000000000000000000",
            5_000_000n,
            7n * 24n * 60n * 60n,
          ],
          { account: buyer.account },
        ),
        /InvalidMerchant/,
      );
    });

    it("rejects a delivery window below MIN_DELIVERY_WINDOW (1h)", async () => {
      const { usdc, escrow } = await deployStack();
      await usdc.write.approve([escrow.address, 5_000_000n], {
        account: buyer.account,
      });
      await assert.rejects(
        escrow.write.createAndDeposit(
          [merchant.account.address, 5_000_000n, 60n], // 60s — too short
          { account: buyer.account },
        ),
        /InvalidDeliveryWindow/,
      );
    });

    it("rejects a delivery window above MAX_DELIVERY_WINDOW (60d)", async () => {
      const { usdc, escrow } = await deployStack();
      await usdc.write.approve([escrow.address, 5_000_000n], {
        account: buyer.account,
      });
      const tooLong = 365n * 24n * 60n * 60n; // 1 year
      await assert.rejects(
        escrow.write.createAndDeposit(
          [merchant.account.address, 5_000_000n, tooLong],
          { account: buyer.account },
        ),
        /InvalidDeliveryWindow/,
      );
    });

    it("produces unique escrowIds for same (buyer, merchant, amount) in same block", async () => {
      // Nonce keeps the id unique even when the rest of the input
      // collides. Two deposits in immediate succession should land
      // distinct rows.
      const { usdc, escrow } = await deployStack();
      const a = await depositOnce({ usdc, escrow });
      const b = await depositOnce({ usdc, escrow });
      assert.notEqual(a.escrowId, b.escrowId);
    });
  });

  // ----------------------------------------------------------------
  //  confirmDelivery()
  // ----------------------------------------------------------------

  describe("confirmDelivery", () => {
    it("transfers locked USDC to the merchant atomically", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId, amount } = await depositOnce({ usdc, escrow });

      const before = await usdc.read.balanceOf([merchant.account.address]);
      await escrow.write.confirmDelivery([escrowId], { account: buyer.account });
      const after = await usdc.read.balanceOf([merchant.account.address]);

      assert.equal(after - before, amount);

      // Escrow row now in Released state.
      const e = await escrow.read.getEscrow([escrowId]);
      assert.equal(e.state, 1); // State.Released

      // No funds left in the contract.
      assert.equal(await usdc.read.balanceOf([escrow.address]), 0n);
    });

    it("reverts when called by someone other than the buyer", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      await assert.rejects(
        escrow.write.confirmDelivery([escrowId], { account: attacker.account }),
        /NotBuyer/,
      );
    });

    it("reverts on a bogus escrowId", async () => {
      const { escrow } = await deployStack();
      const fakeId =
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`;
      await assert.rejects(
        escrow.write.confirmDelivery([fakeId], { account: buyer.account }),
        /EscrowNotFound/,
      );
    });

    it("reverts on an already-released escrow", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      await escrow.write.confirmDelivery([escrowId], { account: buyer.account });
      await assert.rejects(
        escrow.write.confirmDelivery([escrowId], { account: buyer.account }),
        /EscrowNotPending/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  refundOnTimeout()
  // ----------------------------------------------------------------

  describe("refundOnTimeout", () => {
    it("reverts before the delivery deadline elapses", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      await assert.rejects(
        escrow.write.refundOnTimeout([escrowId], { account: buyer.account }),
        /DeadlineNotReached/,
      );
    });

    it("returns the funds to the buyer after the deadline", async () => {
      const { usdc, escrow } = await deployStack();
      const window = 60n * 60n; // 1h — minimum
      const { escrowId, amount } = await depositOnce({ usdc, escrow }, { window });

      const before = await usdc.read.balanceOf([buyer.account.address]);

      // Advance EVM time past the deadline.
      await publicClient.request({
        method: "evm_increaseTime" as any,
        params: [Number(window) + 1] as any,
      });
      await publicClient.request({
        method: "evm_mine" as any,
        params: [] as any,
      });

      await escrow.write.refundOnTimeout([escrowId], { account: buyer.account });

      const after = await usdc.read.balanceOf([buyer.account.address]);
      assert.equal(after - before, amount);

      const e = await escrow.read.getEscrow([escrowId]);
      assert.equal(e.state, 2); // State.Refunded
    });

    it("reverts when called by someone other than the buyer", async () => {
      const { usdc, escrow } = await deployStack();
      const window = 60n * 60n;
      const { escrowId } = await depositOnce({ usdc, escrow }, { window });

      await publicClient.request({
        method: "evm_increaseTime" as any,
        params: [Number(window) + 1] as any,
      });
      await publicClient.request({ method: "evm_mine" as any, params: [] as any });

      await assert.rejects(
        escrow.write.refundOnTimeout([escrowId], { account: attacker.account }),
        /NotBuyer/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  raiseDispute() / resolveDispute()
  // ----------------------------------------------------------------

  describe("dispute flow", () => {
    it("buyer can raise a dispute", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      await escrow.write.raiseDispute([escrowId], { account: buyer.account });
      const e = await escrow.read.getEscrow([escrowId]);
      assert.equal(e.state, 3); // State.Disputed
    });

    it("merchant can raise a dispute", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      await escrow.write.raiseDispute([escrowId], { account: merchant.account });
      const e = await escrow.read.getEscrow([escrowId]);
      assert.equal(e.state, 3);
    });

    it("rejects raise by a non-party", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      await assert.rejects(
        escrow.write.raiseDispute([escrowId], { account: attacker.account }),
        /NotBuyerOrMerchant/,
      );
    });

    it("resolver releases funds to merchant when verdict is true", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId, amount } = await depositOnce({ usdc, escrow });
      await escrow.write.raiseDispute([escrowId], { account: merchant.account });

      const before = await usdc.read.balanceOf([merchant.account.address]);
      await escrow.write.resolveDispute([escrowId, true], {
        account: disputeResolver.account,
      });
      const after = await usdc.read.balanceOf([merchant.account.address]);
      assert.equal(after - before, amount);

      const e = await escrow.read.getEscrow([escrowId]);
      assert.equal(e.state, 4); // State.ResolvedRelease
    });

    it("resolver refunds buyer when verdict is false", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId, amount } = await depositOnce({ usdc, escrow });
      await escrow.write.raiseDispute([escrowId], { account: buyer.account });

      const before = await usdc.read.balanceOf([buyer.account.address]);
      await escrow.write.resolveDispute([escrowId, false], {
        account: disputeResolver.account,
      });
      const after = await usdc.read.balanceOf([buyer.account.address]);
      assert.equal(after - before, amount);

      const e = await escrow.read.getEscrow([escrowId]);
      assert.equal(e.state, 5); // State.ResolvedRefund
    });

    it("rejects resolve by non-resolver", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      await escrow.write.raiseDispute([escrowId], { account: buyer.account });
      await assert.rejects(
        escrow.write.resolveDispute([escrowId, true], { account: attacker.account }),
        /NotDisputeResolver/,
      );
    });

    it("rejects resolve when the escrow isn't in Disputed state", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      // Still Pending — never disputed.
      await assert.rejects(
        escrow.write.resolveDispute([escrowId, true], {
          account: disputeResolver.account,
        }),
        /EscrowNotDisputed/,
      );
    });

    it("rejects confirmDelivery after dispute (Pending check)", async () => {
      const { usdc, escrow } = await deployStack();
      const { escrowId } = await depositOnce({ usdc, escrow });
      await escrow.write.raiseDispute([escrowId], { account: merchant.account });
      await assert.rejects(
        escrow.write.confirmDelivery([escrowId], { account: buyer.account }),
        /EscrowNotPending/,
      );
    });

    it("rejects refundOnTimeout once a dispute is raised, even after deadline", async () => {
      const { usdc, escrow } = await deployStack();
      const window = 60n * 60n;
      const { escrowId } = await depositOnce({ usdc, escrow }, { window });
      await escrow.write.raiseDispute([escrowId], { account: merchant.account });

      await publicClient.request({
        method: "evm_increaseTime" as any,
        params: [Number(window) + 1] as any,
      });
      await publicClient.request({ method: "evm_mine" as any, params: [] as any });

      await assert.rejects(
        escrow.write.refundOnTimeout([escrowId], { account: buyer.account }),
        /EscrowNotPending/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  Admin: setDisputeResolver
  // ----------------------------------------------------------------

  describe("setDisputeResolver", () => {
    it("rotates the resolver address", async () => {
      const { escrow } = await deployStack();
      await escrow.write.setDisputeResolver([attacker.account.address], {
        account: disputeResolver.account,
      });
      const next = await escrow.read.disputeResolver();
      same(next, attacker.account.address);
    });

    it("rejects rotation by a non-resolver caller", async () => {
      const { escrow } = await deployStack();
      await assert.rejects(
        escrow.write.setDisputeResolver([attacker.account.address], {
          account: attacker.account,
        }),
        /NotDisputeResolver/,
      );
    });

    it("rejects setting resolver to the zero address", async () => {
      const { escrow } = await deployStack();
      await assert.rejects(
        escrow.write.setDisputeResolver(
          ["0x0000000000000000000000000000000000000000"],
          { account: disputeResolver.account },
        ),
        /InvalidDisputeResolver/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  Constructor invariants
  // ----------------------------------------------------------------

  describe("constructor", () => {
    it("rejects the zero USDC address", async () => {
      await assert.rejects(
        viem.deployContract("KajotaEscrow", [
          "0x0000000000000000000000000000000000000000",
          disputeResolver.account.address,
        ]),
        /InvalidUsdc/,
      );
    });

    it("rejects the zero dispute-resolver address", async () => {
      const usdc = await viem.deployContract("MockUSDC");
      await assert.rejects(
        viem.deployContract("KajotaEscrow", [
          usdc.address,
          "0x0000000000000000000000000000000000000000",
        ]),
        /InvalidDisputeResolver/,
      );
    });
  });
});
