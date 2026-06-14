/**
 * Deploy script for Kajota Mesh contracts.
 *
 * Deploys the registry first, then the escrow that references it.
 * On Base Sepolia uses the real Circle testnet USDC; on other
 * chains expects USDC_<NETWORK> env to point at the right ERC20.
 *
 * Usage:
 *   pnpm --filter @kajota-mesh/contracts deploy:base-sepolia
 *   pnpm --filter @kajota-mesh/contracts deploy:mantle-sepolia
 *
 * Required env (see .env.example at the repo root):
 *   DEPLOYER_PRIVATE_KEY  — funded with the chain's testnet ETH
 *   USDC_BASE_SEPOLIA     — Circle USDC address (already filled in
 *                           .env.example for Base Sepolia)
 *   INITIAL_RELEASE_AUTH  — optional; defaults to deployer
 *
 * Output:
 *   - prints deployed addresses to stdout
 *   - writes deployments/<chainId>.json so the attestation package
 *     and any downstream agents can read the latest addresses
 *     without grepping logs
 */
import { network } from "hardhat";
import { getAddress, type Address } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const USDC_ADDRESS_BY_CHAIN_ID: Record<number, string | undefined> = {
  // Ethereum Sepolia — Circle's official testnet USDC. Hardcoded
  // fallback so the deploy works without an extra .env entry.
  11155111:
    process.env.USDC_ETHEREUM_SEPOLIA ??
    "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  84532: process.env.USDC_BASE_SEPOLIA, // Base Sepolia
  5003: process.env.USDC_MANTLE_SEPOLIA, // Mantle Sepolia
  // Arbitrum Sepolia — Circle's official testnet USDC. Hardcoded
  // fallback so the deploy works without an extra .env entry.
  421614:
    process.env.USDC_ARBITRUM_SEPOLIA ??
    "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
};

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const chainId = await publicClient.getChainId();
  const CHAIN_NAMES: Record<number, string> = {
    11155111: "Ethereum Sepolia",
    84532: "Base Sepolia",
    5003: "Mantle Sepolia",
    421614: "Arbitrum Sepolia",
  };
  const chainName =
    publicClient.chain?.name ?? CHAIN_NAMES[chainId] ?? `chain-${chainId}`;

  console.log(`\nKajota Mesh — deploy on ${chainName} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.account.address}`);
  const balance = await publicClient.getBalance({
    address: deployer.account.address,
  });
  console.log(`Balance:  ${balance} wei`);
  if (balance === 0n) {
    throw new Error(
      "Deployer balance is 0 — top up the EOA with testnet ETH before retrying.",
    );
  }

  // ---- USDC address ------------------------------------------------
  const usdcEnvValue = USDC_ADDRESS_BY_CHAIN_ID[chainId];
  if (!usdcEnvValue) {
    throw new Error(
      `No USDC address configured for chainId ${chainId}. Add USDC_<NETWORK> to .env.`,
    );
  }
  const usdcAddress = getAddress(usdcEnvValue) as Address;
  console.log(`USDC:     ${usdcAddress}`);

  // ---- releaseAuth -------------------------------------------------
  const releaseAuthEnv = process.env.INITIAL_RELEASE_AUTH;
  const releaseAuth: Address =
    releaseAuthEnv && releaseAuthEnv.length > 0
      ? (getAddress(releaseAuthEnv) as Address)
      : (deployer.account.address as Address);
  console.log(`Release:  ${releaseAuth}\n`);

  // ---- 1. CosellRegistry ------------------------------------------
  console.log("Deploying CosellRegistry …");
  const registry = await viem.deployContract("CosellRegistry");
  console.log(`  → CosellRegistry @ ${registry.address}`);

  // ---- 2. CosellEscrow --------------------------------------------
  console.log("Deploying CosellEscrow …");
  const escrow = await viem.deployContract("CosellEscrow", [
    usdcAddress,
    registry.address,
    releaseAuth,
  ]);
  console.log(`  → CosellEscrow   @ ${escrow.address}\n`);

  // ---- 3. Persist addresses ---------------------------------------
  const deploymentsDir = path.resolve(
    import.meta.dirname,
    "..",
    "deployments",
  );
  mkdirSync(deploymentsDir, { recursive: true });
  const out = {
    chainId,
    chainName,
    deployer: deployer.account.address,
    usdc: usdcAddress,
    releaseAuth,
    registry: registry.address,
    escrow: escrow.address,
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(deploymentsDir, `${chainId}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);

  console.log("\nDone. Next steps:");
  console.log("  1. Verify on Basescan:");
  console.log(
    `     npx hardhat verify --network ${network.name} ${registry.address}`,
  );
  console.log(
    `     npx hardhat verify --network ${network.name} ${escrow.address} \\\n` +
      `       ${usdcAddress} ${registry.address} ${releaseAuth}`,
  );
  console.log("  2. Fund the deployer with Base Sepolia USDC for E2E test:");
  console.log("     https://faucet.circle.com (pick Base Sepolia)");
  console.log("  3. Wire Chainlink Functions consumer to releaseAuth.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
