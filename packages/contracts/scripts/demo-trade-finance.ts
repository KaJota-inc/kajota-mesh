/**
 * Kajota Trade — end-to-end SME invoice-financing demo (Ignyte).
 *
 * Runs the ENTIRE trade-finance lifecycle on-chain against the local
 * in-memory node — no funded wallet, no faucet, no testnet needed:
 *
 *     pnpm --filter @kajota-mesh/contracts demo:trade-finance
 *
 * Actors (distinct local signers):
 *   service   — Kajota ops: ScoreAttestation attester, ReceivableRegistry
 *               controller, escrow releaseAuth/arbiter/owner.
 *   supplier  — the SME that raised the invoice and wants cash now.
 *   financier — advances working capital against the invoice.
 *   debtor    — the buyer who owes the invoice, pays at maturity.
 *
 * Lifecycle:
 *   1. Score the SME (Coach engine, off-chain) → anchor the hash +
 *      headline score/band on ScoreAttestation. Band A → 90% advance.
 *   2. Tokenize the invoice as a receivable (ReceivableRegistry).
 *   3. Financier advances 90% of face to the supplier; ops records it
 *      (markFinanced).
 *   4. At maturity the debtor pays the face value into the escrow
 *      letter-of-credit; on the debtor's confirmation it auto-splits —
 *      financier recovers principal + fee, supplier gets the residual.
 *   5. Ops closes the loop (markRepaid).
 *
 * The 910/Band-A score is exactly what the Coach engine produces for
 * this SME — see kajota-coach: skill/demo/run_scoring.py.
 *
 * Reusable on live Amoy by running with --network polygonAmoy against
 * the deployed stack (the deploy scripts emit all four addresses).
 */
import { network } from "hardhat";
import assert from "node:assert/strict";
import { keccak256, stringToHex, getAddress, type Address } from "viem";

const FACE = 5_000_000n; // 5.00 USDC invoice (6-decimal)
const ADVANCE = 4_500_000n; // 90% advance (Band A) → supplier gets cash now
const COMMISSION_BPS = 500n; // 5% of face is the supplier's residual at payout;
//                              the financier (wholesaler) recovers the other 95%
//                              = principal 4.50 + 0.25 financing fee.
const SCORE = 910;
const BAND = 0; // A

const usd = (units: bigint) => `$${(Number(units) / 1e6).toFixed(2)}`;

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [service, supplier, financier, debtor] = await viem.getWalletClients();

  const line = () => console.log("─".repeat(60));
  console.log("\nKajota Trade — SME invoice-financing lifecycle (local node)");
  line();
  console.log(`service   ${service.account.address}`);
  console.log(`supplier  ${supplier.account.address}`);
  console.log(`financier ${financier.account.address}`);
  console.log(`debtor    ${debtor.account.address}`);

  // ---- deploy stack ------------------------------------------------
  const usdc = await viem.deployContract("MockUSDC");
  const cosellRegistry = await viem.deployContract("CosellRegistry");
  const escrow = await viem.deployContract("CosellEscrow", [
    usdc.address,
    cosellRegistry.address,
    service.account.address as Address, // releaseAuth
    service.account.address as Address, // arbiter
    service.account.address as Address, // owner
  ]);
  const receivables = await viem.deployContract("ReceivableRegistry", [
    service.account.address as Address, // controller
  ]);
  const scores = await viem.deployContract("ScoreAttestation", [
    service.account.address as Address, // attester
  ]);

  // Seed balances: financier funds the advance, debtor funds repayment.
  await usdc.write.mint([financier.account.address, FACE]);
  await usdc.write.mint([debtor.account.address, FACE]);

  // ---- 1. credit score → on-chain anchor ---------------------------
  line();
  console.log("1. Credit score (Coach engine) → ScoreAttestation");
  const scorePayload = stringToHex(
    JSON.stringify({
      demo: "kajota-trade",
      subject: supplier.account.address.toLowerCase(),
      score: SCORE,
      band: BAND,
    }),
  );
  const scoreHash = keccak256(scorePayload);
  await scores.write.attest(
    [supplier.account.address, scoreHash, SCORE, BAND],
    { account: service.account },
  );
  const onchainScore = await scores.read.getScore([supplier.account.address]);
  const verified = await scores.read.verifyPayload([
    supplier.account.address,
    scorePayload,
  ]);
  assert.equal(onchainScore.score, SCORE);
  assert.equal(onchainScore.band, BAND);
  assert.equal(verified, true);
  console.log(
    `   score ${onchainScore.score}/1000  Band A  → 90% advance rate`,
  );
  console.log(`   hash ${scoreHash.slice(0, 18)}…  verifyPayload: ${verified}`);

  // ---- 2. tokenize the invoice -------------------------------------
  line();
  console.log("2. Tokenize invoice → ReceivableRegistry");
  const invoiceId = "INV-2026-0042";
  const dueDate =
    (await publicClient.getBlock()).timestamp + 30n * 24n * 60n * 60n;
  await receivables.write.register(
    [
      invoiceId,
      supplier.account.address,
      debtor.account.address,
      FACE,
      dueDate,
      "USDC",
    ],
    { account: supplier.account },
  );
  const receivableId = await receivables.read.computeReceivableId([
    invoiceId,
    supplier.account.address,
    debtor.account.address,
  ]);
  let rec = await receivables.read.getReceivable([receivableId]);
  console.log(
    `   ${invoiceId}  face ${usd(rec.faceValue)}  status ${rec.status} (Registered)`,
  );

  // ---- 3. financier advances working capital -----------------------
  line();
  console.log("3. Finance → advance to supplier + markFinanced");
  await usdc.write.transfer([supplier.account.address, ADVANCE], {
    account: financier.account,
  });
  await receivables.write.markFinanced(
    [receivableId, financier.account.address, ADVANCE],
    { account: service.account },
  );
  rec = await receivables.read.getReceivable([receivableId]);
  console.log(
    `   financier advanced ${usd(ADVANCE)} → supplier  (status ${rec.status} = Financed)`,
  );

  // ---- 4. debtor repays via the escrow letter of credit ------------
  line();
  console.log("4. Maturity → debtor pays into escrow → auto-split");
  // The financing terms as a CosellEscrow listing: financier is the
  // wholesaler (recovers 95% = principal + fee), supplier the coseller
  // (5% residual). The debtor's payment can only route this way.
  await cosellRegistry.write.register(
    [
      invoiceId,
      financier.account.address, // wholesaler = financier
      supplier.account.address, // coseller  = supplier
      Number(COMMISSION_BPS),
      "USDC",
    ],
    { account: financier.account },
  );
  const listingId = await cosellRegistry.read.computeListingId([
    invoiceId,
    financier.account.address,
    supplier.account.address,
  ]);

  await usdc.write.approve([escrow.address, FACE], { account: debtor.account });
  await escrow.write.deposit([listingId, FACE], { account: debtor.account });
  const deposits = await escrow.getEvents.Deposited({}, { fromBlock: 0n });
  const depositId = deposits[0]!.args.depositId!;
  console.log(`   debtor deposited ${usd(FACE)} into escrow`);

  // Debtor confirms the goods/invoice — the trustless release path.
  await escrow.write.confirmReceipt([depositId], { account: debtor.account });
  const released = await escrow.getEvents.Released({}, { fromBlock: 0n });
  const { wholesalerShare, cosellerShare } = released[0]!.args;
  console.log(
    `   released → financier ${usd(wholesalerShare!)}  supplier ${usd(cosellerShare!)}`,
  );

  // ---- 5. close the loop -------------------------------------------
  line();
  console.log("5. Settle → markRepaid");
  await receivables.write.markRepaid([receivableId], {
    account: service.account,
  });
  rec = await receivables.read.getReceivable([receivableId]);
  console.log(`   receivable status ${rec.status} = Repaid`);

  // ---- ledger + invariants -----------------------------------------
  line();
  const balOf = async (a: Address) =>
    (await usdc.read.balanceOf([a])) as bigint;
  const supplierBal = await balOf(supplier.account.address as Address);
  const financierBal = await balOf(financier.account.address as Address);
  const debtorBal = await balOf(debtor.account.address as Address);
  const escrowBal = await balOf(escrow.address as Address);

  console.log("Final ledger (USDC):");
  console.log(`   supplier   ${usd(supplierBal)}   (advance + residual)`);
  console.log(`   financier  ${usd(financierBal)}   (started ${usd(FACE)} → principal back + fee)`);
  console.log(`   debtor     ${usd(debtorBal)}   (paid the invoice)`);
  console.log(`   escrow     ${usd(escrowBal)}   (fully settled)`);

  // Invariants: escrow drained, debtor paid face, financier profits the
  // fee, supplier ends with face minus the financing discount.
  assert.equal(escrowBal, 0n, "escrow must be fully settled");
  assert.equal(debtorBal, 0n, "debtor paid the full face value");
  assert.equal(supplierBal, ADVANCE + FACE - wholesalerShare!);
  assert.equal(financierBal, FACE - ADVANCE + wholesalerShare!);
  assert.equal(getAddress(rec.financier), getAddress(financier.account.address));
  assert.equal(rec.status, 2); // Repaid

  line();
  console.log("✓ Lifecycle complete — all invariants hold.");
  const fee = wholesalerShare! - ADVANCE;
  console.log(
    `  Supplier got ${usd(supplierBal)} of a ${usd(FACE)} invoice up-front economics; ` +
      `financier earned ${usd(fee)} fee.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
