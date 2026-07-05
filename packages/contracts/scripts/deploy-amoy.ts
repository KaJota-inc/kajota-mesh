/**
 * One-shot Polygon Amoy (chainId 80002) deploy — the Ignyte x Polygon
 * Smart Commerce Challenge (SME Trade Finance track) target chain.
 *
 * Amoy DOES have a canonical Circle USDC (0x41E9…7582), used by the
 * standard scripts/deploy.ts path. This variant instead deploys the
 * 6-decimal MockUSDC as the escrow settlement token so the demo can
 * mint arbitrary balances to the financier + SME wallets without
 * depending on a faucet — the invoice-financing flow needs to fund
 * escrow and settle repayment on demand.
 *
 * It mirrors scripts/deploy.ts: MockUSDC → CosellRegistry →
 * CosellEscrow, and writes deployments/80002.json so the mesh skill
 * and any downstream agents get the addresses without grepping logs.
 *
 * Usage:
 *   pnpm --filter @kajota-mesh/contracts deploy:amoy:mock
 *
 * For the Circle-USDC path instead:
 *   pnpm --filter @kajota-mesh/contracts deploy:amoy
 *
 * Required env (repo-root .env):
 *   DEPLOYER_PRIVATE_KEY — funded with Amoy POL
 *                          (faucet: https://faucet.polygon.technology)
 */
import { network } from "hardhat";
import { getAddress, type Address } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";
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

  console.log(`\nKajota Mesh — Amoy deploy on ${chainName} (chainId ${chainId})`);
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

  // ---- 1. MockUSDC (faucet-free, mintable settlement token) --------
  console.log("Deploying MockUSDC …");
  const usdc = await viem.deployContract("MockUSDC");
  console.log(`  → MockUSDC       @ ${usdc.address}`);

  // ---- 2. CosellRegistry ------------------------------------------
  console.log("Deploying CosellRegistry …");
  const registry = await viem.deployContract("CosellRegistry");
  console.log(`  → CosellRegistry @ ${registry.address}`);

  // ---- 3. CosellEscrow --------------------------------------------
  const releaseAuth = deployer.account.address as Address;
  console.log("Deploying CosellEscrow …");
  const escrow = await viem.deployContract("CosellEscrow", [
    getAddress(usdc.address),
    getAddress(registry.address),
    releaseAuth,
    releaseAuth, // arbiter (defaults to deployer; rotate post-deploy)
    releaseAuth, // owner (defaults to deployer; transferOwnership post-deploy)
  ]);
  console.log(`  → CosellEscrow   @ ${escrow.address}\n`);

  // ---- 4. ReceivableRegistry (SME trade-finance) ------------------
  // controller (lifecycle authority) defaults to the deployer; rotate
  // to the escrow/ops/scoring service post-deploy via setController.
  console.log("Deploying ReceivableRegistry …");
  const receivables = await viem.deployContract("ReceivableRegistry", [
    releaseAuth,
  ]);
  console.log(`  → ReceivableRegistry @ ${receivables.address}\n`);

  // ---- 5. Persist addresses ---------------------------------------
  const deploymentsDir = path.resolve(import.meta.dirname, "..", "deployments");
  mkdirSync(deploymentsDir, { recursive: true });
  const out = {
    chainId,
    chainName,
    deployer: deployer.account.address,
    usdc: getAddress(usdc.address),
    usdcNote:
      "MockUSDC (6-decimal, mintable) — used for faucet-free demos. " +
      "Canonical Circle USDC on Amoy is 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582 " +
      "(use scripts/deploy.ts for that path).",
    releaseAuth,
    registry: getAddress(registry.address),
    escrow: getAddress(escrow.address),
    receivableRegistry: getAddress(receivables.address),
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(deploymentsDir, `${chainId}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
  console.log("\nDone. Amoy explorer: https://amoy.polygonscan.com");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
