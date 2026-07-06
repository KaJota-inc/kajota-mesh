import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, keccak256, toHex } from "viem";

/**
 * Unit tests for ScoreAttestation.
 *
 * Covers:
 *   - attest: attester anchors score/band/hash; latest + count update
 *   - range guards: score <= 1000, band <= 4, non-zero subject/hash
 *   - auth: only allow-listed attesters write; owner manages the list
 *   - views: getScore / hasScore / verifyPayload (hash round-trip)
 *
 * Address normalization mirrors CosellRegistry's convention.
 */
describe("ScoreAttestation", async () => {
  const { viem } = await network.create();
  const [owner, attester, subject, financier, other] =
    await viem.getWalletClients();

  const same = (a: string, b: string) =>
    assert.equal(getAddress(a), getAddress(b));

  const PAYLOAD = toHex(
    JSON.stringify({ supplier: "sme-1", score: 820, band: 1, v: 1 }),
  );
  const SCORE_HASH = keccak256(PAYLOAD);

  /** Deploy with `attester` as the initial authorized attester. */
  const deploy = async () =>
    await viem.deployContract("ScoreAttestation", [attester.account.address]);

  // ----------------------------------------------------------------
  //  attest()
  // ----------------------------------------------------------------

  describe("attest", () => {
    it("anchors score/band/hash and bumps attestationCount", async () => {
      const sa = await deploy();

      await sa.write.attest(
        [subject.account.address, SCORE_HASH, 820, 1],
        { account: attester.account },
      );

      const a = await sa.read.getScore([subject.account.address]);
      assert.equal(a.scoreHash, SCORE_HASH);
      assert.equal(a.score, 820);
      assert.equal(a.band, 1);
      same(a.attester, attester.account.address);
      assert.notEqual(a.attestedAt, 0n);

      assert.equal(
        await sa.read.attestationCount([subject.account.address]),
        1n,
      );
      assert.equal(await sa.read.hasScore([subject.account.address]), true);
    });

    it("overwrites with the latest and increments the count", async () => {
      const sa = await deploy();
      await sa.write.attest([subject.account.address, SCORE_HASH, 820, 1], {
        account: attester.account,
      });

      const newPayload = toHex(JSON.stringify({ score: 640, band: 2, v: 2 }));
      const newHash = keccak256(newPayload);
      await sa.write.attest([subject.account.address, newHash, 640, 2], {
        account: attester.account,
      });

      const a = await sa.read.getScore([subject.account.address]);
      assert.equal(a.score, 640);
      assert.equal(a.band, 2);
      assert.equal(a.scoreHash, newHash);
      assert.equal(
        await sa.read.attestationCount([subject.account.address]),
        2n,
      );
    });

    it("reverts NotAttester when a non-attester writes", async () => {
      const sa = await deploy();
      await assert.rejects(
        sa.write.attest([subject.account.address, SCORE_HASH, 820, 1], {
          account: other.account,
        }),
        /NotAttester/,
      );
    });

    it("reverts InvalidSubject on the zero address", async () => {
      const sa = await deploy();
      await assert.rejects(
        sa.write.attest(
          ["0x0000000000000000000000000000000000000000", SCORE_HASH, 820, 1],
          { account: attester.account },
        ),
        /InvalidSubject/,
      );
    });

    it("reverts ZeroScoreHash on an empty hash", async () => {
      const sa = await deploy();
      await assert.rejects(
        sa.write.attest(
          [
            subject.account.address,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            820,
            1,
          ],
          { account: attester.account },
        ),
        /ZeroScoreHash/,
      );
    });

    it("reverts ScoreOutOfRange when score > 1000", async () => {
      const sa = await deploy();
      await assert.rejects(
        sa.write.attest([subject.account.address, SCORE_HASH, 1001, 1], {
          account: attester.account,
        }),
        /ScoreOutOfRange/,
      );
    });

    it("reverts BandOutOfRange when band > 4", async () => {
      const sa = await deploy();
      await assert.rejects(
        sa.write.attest([subject.account.address, SCORE_HASH, 820, 5], {
          account: attester.account,
        }),
        /BandOutOfRange/,
      );
    });
  });

  // ----------------------------------------------------------------
  //  admin — attester allowlist + ownership
  // ----------------------------------------------------------------

  describe("admin", () => {
    it("owner adds an attester who can then write", async () => {
      const sa = await deploy();
      await sa.write.setAttester([other.account.address, true], {
        account: owner.account,
      });
      assert.equal(await sa.read.isAttester([other.account.address]), true);

      await sa.write.attest([subject.account.address, SCORE_HASH, 700, 1], {
        account: other.account,
      });
      assert.equal(
        (await sa.read.getScore([subject.account.address])).score,
        700,
      );
    });

    it("owner revokes an attester", async () => {
      const sa = await deploy();
      await sa.write.setAttester([attester.account.address, false], {
        account: owner.account,
      });
      await assert.rejects(
        sa.write.attest([subject.account.address, SCORE_HASH, 700, 1], {
          account: attester.account,
        }),
        /NotAttester/,
      );
    });

    it("reverts NotOwner when a non-owner edits the allowlist", async () => {
      const sa = await deploy();
      await assert.rejects(
        sa.write.setAttester([other.account.address, true], {
          account: other.account,
        }),
        /NotOwner/,
      );
    });

    it("transfers ownership", async () => {
      const sa = await deploy();
      await sa.write.transferOwnership([other.account.address], {
        account: owner.account,
      });
      same(await sa.read.owner(), other.account.address);
    });
  });

  // ----------------------------------------------------------------
  //  views
  // ----------------------------------------------------------------

  describe("views", () => {
    it("getScore reverts NoAttestation for an unscored subject", async () => {
      const sa = await deploy();
      await assert.rejects(
        sa.read.getScore([subject.account.address]),
        /NoAttestation/,
      );
      assert.equal(await sa.read.hasScore([subject.account.address]), false);
    });

    it("verifyPayload round-trips the anchored hash", async () => {
      const sa = await deploy();
      await sa.write.attest([subject.account.address, SCORE_HASH, 820, 1], {
        account: attester.account,
      });

      // A financier recomputes the hash from the shared payload.
      assert.equal(
        await sa.read.verifyPayload([subject.account.address, PAYLOAD]),
        true,
      );
      // A tampered payload fails.
      const tampered = toHex(JSON.stringify({ score: 999, band: 0 }));
      assert.equal(
        await sa.read.verifyPayload([subject.account.address, tampered]),
        false,
      );
    });

    it("verifyPayload returns false for an unscored subject", async () => {
      const sa = await deploy();
      assert.equal(
        await sa.read.verifyPayload([financier.account.address, PAYLOAD]),
        false,
      );
    });
  });
});
