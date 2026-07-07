/**
 * Lean Polygon Amoy deploy — just the two contracts that are NEW for the
 * Ignyte SME Trade Finance track:
 *
 *   ReceivableRegistry  — tokenized invoices
 *   ScoreAttestation    — on-chain trade-credit anchor
 *
 * The escrow letter of credit (CosellEscrow) + MockUSDC are already
 * proven live on Sepolia + Mantle and fully exercised by the local
 * demo, so this footprint fits a single ~0.1 POL faucet drip while
 * still putting the novel deliverables on Polygon.
 *
 *   pnpm --filter @kajota-mesh/contracts deploy:amoy:new
 *
 * For the full 5-contract stack instead: deploy:amoy:mock.
 *
 * Both contracts default their authority (controller / attester) to the
 * deployer = the Kajota scoring service wallet; rotate post-deploy via
 * setController / setAttester.
 *
 * Merges into deployments/80002.json so a later full deploy (or the
 * skill config) can read whatever is live.
 */
import { network } from "hardhat";
import { getAddress, type Address } from "viem";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const chainId = await publicClient.getChainId();
  if (chainId !== 80002) {
    throw new Error(
      `Expected Polygon Amoy (chainId 80002) but connected to ${chainId}. ` +
        `Run with --network polygonAmoy.`,
    );
  }
  const chainName = "Polygon Amoy";

  console.log(`\nKajota Trade — lean Amoy deploy on ${chainName} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.account.address}`);
  const balance = await publicClient.getBalance({
    address: deployer.account.address,
  });
  console.log(`Balance:  ${balance} wei`);
  if (balance === 0n) {
    throw new Error(
      "Deployer balance is 0 — faucet Amoy POL before retrying: " +
        "https://faucet.polygon.technology",
    );
  }

  const releaseAuth = deployer.account.address as Address;

  // ---- 1. ReceivableRegistry --------------------------------------
  console.log("Deploying ReceivableRegistry …");
  const receivables = await viem.deployContract("ReceivableRegistry", [
    releaseAuth,
  ]);
  console.log(`  → ReceivableRegistry @ ${receivables.address}`);

  // ---- 2. ScoreAttestation ----------------------------------------
  console.log("Deploying ScoreAttestation …");
  const scores = await viem.deployContract("ScoreAttestation", [releaseAuth]);
  console.log(`  → ScoreAttestation   @ ${scores.address}\n`);

  // ---- persist (merge with any existing 80002.json) ---------------
  const deploymentsDir = path.resolve(import.meta.dirname, "..", "deployments");
  mkdirSync(deploymentsDir, { recursive: true });
  const outPath = path.join(deploymentsDir, `${chainId}.json`);
  const existing =
    existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
  const out = {
    ...existing,
    chainId,
    chainName,
    deployer: deployer.account.address,
    receivableRegistry: getAddress(receivables.address),
    scoreAttestation: getAddress(scores.address),
    deployedAt: new Date().toISOString(),
    note:
      "Lean Ignyte deploy — ReceivableRegistry + ScoreAttestation only. " +
      "CosellEscrow/MockUSDC live on Sepolia + Mantle; see deploy:amoy:mock " +
      "for the full Amoy stack.",
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);

  console.log("\nDone. Amoy explorer:");
  console.log(`  https://amoy.polygonscan.com/address/${receivables.address}`);
  console.log(`  https://amoy.polygonscan.com/address/${scores.address}`);
  console.log(
    "\nNext: set MESH_SCORE_ATTESTATION_ADDRESS in the coach skill to " +
      `${scores.address}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
