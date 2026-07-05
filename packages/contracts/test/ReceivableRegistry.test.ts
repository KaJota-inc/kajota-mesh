import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, keccak256, encodePacked } from "viem";

/**
 * Unit tests for ReceivableRegistry.
 *
 * Covers the SME trade-finance lifecycle:
 *   - register: tokenize an invoice (happy path + revert paths)
 *   - markFinanced / markRepaid / markDefaulted: controller-driven
 *     status mirror, including the due-date gate on default
 *   - cancel: supplier withdraws a still-unfinanced receivable
 *   - admin: owner-gated controller rotation + ownership transfer
 *   - previewFinancing: pure discount math
 *
 * Status enum (uint8): 0 Registered, 1 Financed, 2 Repaid,
 * 3 Defaulted, 4 Cancelled.
 *
 * Address normalization mirrors CosellRegistry's convention — compare
 * via getAddress() on both sides.
 */
describe("ReceivableRegistry", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, supplier, debtor, financier, controller, other] =
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

  /** A dueDate `days` in the future relative to the latest block. */
  const dueInDays = async (days: number) => {
    const block = await publicClient.getBlock();
    return block.timestamp + BigInt(days * 24 * 60 * 60);
  };

  const INVOICE = "6a0b4c3d6df81b631aa879ab";
  const FACE = 5_000_000n; // 5 USDC (6-decimal)
  const ADVANCE = 4_500_000n; // 4.5 USDC advance → 0.5 USDC discount

  /** Deploy a fresh registry with `controller` as the lifecycle authority. */
  const deploy = async () => {
    // owner is the default (first) wallet client → contract owner.
    return await viem.deployContract("ReceivableRegistry", [
      controller.account.address,
    ]);
  };

  /** Deploy + register one receivable; returns { registry, receivableId }. */
  const deployWithReceivable = async () => {
    const registry = await deploy();
    const due = await dueInDays(30);
    await registry.write.register(
      [INVOICE, supplier.account.address, debtor.account.address, FACE, due, "NGN"],
      { account: supplier.account },
    );
    const receivableId = await registry.read.computeReceivableId([
      INVOICE,
      supplier.account.address,
      debtor.account.address,
    ]);
    return { registry, receivableId, due };
  };

  // ----------------------------------------------------------------
  //  register()
  // ----------------------------------------------------------------

  describe("register", () => {
    it("stores a new receivable and emits ReceivableRegistered", async () => {
      const registry = await deploy();
      const due = await dueInDays(30);

      await registry.write.register(
        [INVOICE, supplier.account.address, debtor.account.address, FACE, due, "NGN"],
        { account: supplier.account },
      );

      const receivableId = keccak256(
        encodePacked(
          ["string", "address", "address"],
          [INVOICE, supplier.account.address, debtor.account.address],
        ),
      );

      const r = await registry.read.getReceivable([receivableId]);
      assert.equal(r.invoiceId, INVOICE);
      same(r.supplier, supplier.account.address);
      same(r.debtor, debtor.account.address);
      same(r.financier, "0x0000000000000000000000000000000000000000");
      assert.equal(r.faceValue, FACE);
      assert.equal(r.advanceAmount, 0n);
      assert.equal(r.currency, "NGN");
      assert.equal(r.dueDate, due);
      assert.equal(r.status, 0); // Registered
      assert.notEqual(r.registeredAt, 0n);
    });

    it("appends to invoice and supplier indexes", async () => {
      const { registry, receivableId } = await deployWithReceivable();

      const byInvoice = await registry.read.receivablesForInvoice([INVOICE]);
      assert.equal(byInvoice.length, 1);
      assert.equal(byInvoice[0], receivableId);

      const bySupplier = await registry.read.receivablesForSupplier([
        supplier.account.address,
      ]);
      assert.equal(bySupplier.length, 1);
      assert.equal(bySupplier[0], receivableId);
    });

    it("reverts InvalidSupplier when msg.sender != supplier arg", async () => {
      const registry = await deploy();
      const due = await dueInDays(30);
      await assert.rejects(
        registry.write.register(
          // supplier arg is `debtor` but msg.sender is `supplier`.
          [INVOICE, debtor.account.address, other.account.address, FACE, due, "NGN"],
          { account: supplier.account },
        ),
        /InvalidSupplier/,
      );
    });

    it("reverts InvalidDebtor when debtor == supplier", async () => {
      const registry = await deploy();
      const due = await dueInDays(30);
      await assert.rejects(
        registry.write.register(
          [INVOICE, supplier.account.address, supplier.account.address, FACE, due, "NGN"],
          { account: supplier.account },
        ),
        /InvalidDebtor/,
      );
    });

    it("reverts ZeroFaceValue when faceValue == 0", async () => {
      const registry = await deploy();
      const due = await dueInDays(30);
      await assert.rejects(
        registry.write.register(
          [INVOICE, supplier.account.address, debtor.account.address, 0n, due, "NGN"],
          { account: supplier.account },
        ),
        /ZeroFaceValue/,
      );
    });

    it("reverts DueDateInPast when dueDate is not in the future", async () => {
      const registry = await deploy();
      const past = (await publicClient.getBlock()).timestamp - 1n;
      await assert.rejects(
        registry.write.register(
          [INVOICE, supplier.account.address, debtor.account.address, FACE, past, "NGN"],
          { account: supplier.account },
        ),
        /DueDateInPast/,
      );
    });

    it("reverts ReceivableAlreadyExists on duplicate triple", async () => {
      const { registry, due } = await deployWithReceivable();
      await assert.rejects(
        registry.write.register(
          [INVOICE, supplier.account.address, debtor.account.address, FACE, due, "NGN"],
          { account: supplier.account },
        ),
        /ReceivableAlreadyExists/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  markFinanced()
  // ----------------------------------------------------------------

  describe("markFinanced", () => {
    it("controller marks Financed, records financier + advance, indexes it", async () => {
      const { registry, receivableId } = await deployWithReceivable();

      await registry.write.markFinanced(
        [receivableId, financier.account.address, ADVANCE],
        { account: controller.account },
      );

      const r = await registry.read.getReceivable([receivableId]);
      assert.equal(r.status, 1); // Financed
      same(r.financier, financier.account.address);
      assert.equal(r.advanceAmount, ADVANCE);
      assert.notEqual(r.financedAt, 0n);

      const byFinancier = await registry.read.receivablesForFinancier([
        financier.account.address,
      ]);
      assert.equal(byFinancier.length, 1);
      assert.equal(byFinancier[0], receivableId);
    });

    it("reverts NotController when a non-controller calls", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await assert.rejects(
        registry.write.markFinanced(
          [receivableId, financier.account.address, ADVANCE],
          { account: other.account },
        ),
        /NotController/,
      );
    });

    it("reverts InvalidFinancier when financier == supplier", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await assert.rejects(
        registry.write.markFinanced(
          [receivableId, supplier.account.address, ADVANCE],
          { account: controller.account },
        ),
        /InvalidFinancier/,
      );
    });

    it("reverts InvalidAdvanceAmount when advance > faceValue", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await assert.rejects(
        registry.write.markFinanced(
          [receivableId, financier.account.address, FACE + 1n],
          { account: controller.account },
        ),
        /InvalidAdvanceAmount/,
      );
    });

    it("reverts UnexpectedStatus when already financed", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await registry.write.markFinanced(
        [receivableId, financier.account.address, ADVANCE],
        { account: controller.account },
      );
      await assert.rejects(
        registry.write.markFinanced(
          [receivableId, financier.account.address, ADVANCE],
          { account: controller.account },
        ),
        /UnexpectedStatus/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  markRepaid()
  // ----------------------------------------------------------------

  describe("markRepaid", () => {
    it("controller marks Financed → Repaid", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await registry.write.markFinanced(
        [receivableId, financier.account.address, ADVANCE],
        { account: controller.account },
      );

      await registry.write.markRepaid([receivableId], {
        account: controller.account,
      });

      const r = await registry.read.getReceivable([receivableId]);
      assert.equal(r.status, 2); // Repaid
      assert.notEqual(r.repaidAt, 0n);
    });

    it("reverts UnexpectedStatus when not yet financed", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await assert.rejects(
        registry.write.markRepaid([receivableId], { account: controller.account }),
        /UnexpectedStatus/,
      );
    });

    it("reverts NotController when a non-controller calls", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await registry.write.markFinanced(
        [receivableId, financier.account.address, ADVANCE],
        { account: controller.account },
      );
      await assert.rejects(
        registry.write.markRepaid([receivableId], { account: other.account }),
        /NotController/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  markDefaulted() — due-date gated
  // ----------------------------------------------------------------

  describe("markDefaulted", () => {
    it("reverts NotDueYet before the due date", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await registry.write.markFinanced(
        [receivableId, financier.account.address, ADVANCE],
        { account: controller.account },
      );
      await assert.rejects(
        registry.write.markDefaulted([receivableId], {
          account: controller.account,
        }),
        /NotDueYet/,
      );
    });

    it("marks Defaulted once past the due date", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await registry.write.markFinanced(
        [receivableId, financier.account.address, ADVANCE],
        { account: controller.account },
      );

      await advanceTime(31 * 24 * 60 * 60); // past the 30-day dueDate

      await registry.write.markDefaulted([receivableId], {
        account: controller.account,
      });

      const r = await registry.read.getReceivable([receivableId]);
      assert.equal(r.status, 3); // Defaulted
    });

    it("reverts UnexpectedStatus when not financed", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await advanceTime(31 * 24 * 60 * 60);
      await assert.rejects(
        registry.write.markDefaulted([receivableId], {
          account: controller.account,
        }),
        /UnexpectedStatus/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  cancel()
  // ----------------------------------------------------------------

  describe("cancel", () => {
    it("supplier cancels a still-Registered receivable", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await registry.write.cancel([receivableId], { account: supplier.account });

      const r = await registry.read.getReceivable([receivableId]);
      assert.equal(r.status, 4); // Cancelled
      // history preserved
      assert.notEqual(r.registeredAt, 0n);
    });

    it("reverts NotSupplier when someone else tries", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await assert.rejects(
        registry.write.cancel([receivableId], { account: other.account }),
        /NotSupplier/,
      );
    });

    it("reverts UnexpectedStatus once financed", async () => {
      const { registry, receivableId } = await deployWithReceivable();
      await registry.write.markFinanced(
        [receivableId, financier.account.address, ADVANCE],
        { account: controller.account },
      );
      await assert.rejects(
        registry.write.cancel([receivableId], { account: supplier.account }),
        /UnexpectedStatus/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  admin — controller rotation + ownership
  // ----------------------------------------------------------------

  describe("admin", () => {
    it("owner rotates the controller; new controller can drive status", async () => {
      const { registry, receivableId } = await deployWithReceivable();

      await registry.write.setController([other.account.address], {
        account: owner.account,
      });
      assert.equal(
        getAddress(await registry.read.controller()),
        getAddress(other.account.address),
      );

      // old controller now rejected, new one accepted
      await assert.rejects(
        registry.write.markFinanced(
          [receivableId, financier.account.address, ADVANCE],
          { account: controller.account },
        ),
        /NotController/,
      );
      await registry.write.markFinanced(
        [receivableId, financier.account.address, ADVANCE],
        { account: other.account },
      );
      const r = await registry.read.getReceivable([receivableId]);
      assert.equal(r.status, 1); // Financed
    });

    it("reverts NotOwner when a non-owner rotates the controller", async () => {
      const registry = await deploy();
      await assert.rejects(
        registry.write.setController([other.account.address], {
          account: other.account,
        }),
        /NotOwner/,
      );
    });

    it("transfers ownership", async () => {
      const registry = await deploy();
      await registry.write.transferOwnership([other.account.address], {
        account: owner.account,
      });
      assert.equal(
        getAddress(await registry.read.owner()),
        getAddress(other.account.address),
      );
    });
  });

  // ----------------------------------------------------------------
  //  previewFinancing() — pure discount math
  // ----------------------------------------------------------------

  describe("previewFinancing", () => {
    it("returns faceValue - advance as the financier's return", async () => {
      const registry = await deploy();
      const ret = await registry.read.previewFinancing([FACE, ADVANCE]);
      assert.equal(ret, FACE - ADVANCE); // 0.5 USDC
    });

    it("reverts InvalidAdvanceAmount when advance > faceValue", async () => {
      const registry = await deploy();
      await assert.rejects(
        registry.read.previewFinancing([FACE, FACE + 1n]),
        /InvalidAdvanceAmount/,
      );
    });
  });
});
