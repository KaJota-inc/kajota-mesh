/**
 * One-shot Mantle Sepolia (chainId 5003) deploy — the Mantle Turing
 * Test Phase 2 "breadth points" cross-deploy.
 *
 * Mantle Sepolia has no canonical Circle USDC, so this deploys the
 * 6-decimal MockUSDC as the escrow settlement token, then mirrors
 * scripts/deploy.ts: CosellRegistry → CosellEscrow, and writes
 * deployments/5003.json so downstream readers get the addresses.
 *
 * Usage:
 *   pnpm --filter @kajota-mesh/contracts deploy:mantle-sepolia:mock
 *
 * Required env (repo-root .env):
 *   DEPLOYER_PRIVATE_KEY — funded with Mantle Sepolia ETH
 *                          (faucet: https://faucet.sepolia.mantle.xyz)
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
  if (chainId !== 5003) {
    throw new Error(
      `Expected Mantle Sepolia (chainId 5003) but connected to ${chainId}. ` +
        `Run with --network mantleSepolia.`,
    );
  }
  const chainName = "Mantle Sepolia";

  console.log(`\nKajota Mesh — Mantle cross-deploy on ${chainName} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.account.address}`);
  const balance = await publicClient.getBalance({
    address: deployer.account.address,
  });
  console.log(`Balance:  ${balance} wei`);
  if (balance === 0n) {
    throw new Error(
      "Deployer balance is 0 — faucet Mantle Sepolia ETH before retrying: " +
        "https://faucet.sepolia.mantle.xyz",
    );
  }

  // ---- 1. MockUSDC (no canonical Circle USDC on Mantle Sepolia) ----
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

  // ---- 4. Persist addresses ---------------------------------------
  const deploymentsDir = path.resolve(import.meta.dirname, "..", "deployments");
  mkdirSync(deploymentsDir, { recursive: true });
  const out = {
    chainId,
    chainName,
    deployer: deployer.account.address,
    usdc: getAddress(usdc.address),
    usdcNote:
      "MockUSDC (6-decimal) — Mantle Sepolia testnet has no canonical Circle USDC",
    releaseAuth,
    registry: getAddress(registry.address),
    escrow: getAddress(escrow.address),
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(deploymentsDir, `${chainId}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
  console.log("\nDone. Mantle Sepolia explorer: https://explorer.sepolia.mantle.xyz");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
