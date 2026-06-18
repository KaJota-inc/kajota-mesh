/**
 * Escrow-only (re)deploy — upgrades CosellEscrow in place without
 * touching the existing CosellRegistry, so registered listings are
 * preserved. Deploys the new escrow against the registry + USDC already
 * recorded in deployments/<chainId>.json (or overridden via env), then
 * rewrites the json's `escrow` field (keeping the old one as
 * `prevEscrow`).
 *
 * Usage:
 *   hardhat run --network mantleSepolia scripts/deploy-escrow.ts
 *   hardhat run --network sepolia       scripts/deploy-escrow.ts
 *
 * Required env (repo-root .env):
 *   DEPLOYER_PRIVATE_KEY — funded with the chain's native gas token.
 * Optional env (else read from deployments/<chainId>.json):
 *   USDC_ADDRESS, REGISTRY_ADDRESS
 */
import { network } from "hardhat";
import { getAddress, type Address } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  const outPath = path.resolve(
    import.meta.dirname,
    "..",
    "deployments",
    `${chainId}.json`,
  );
  let prior: Record<string, unknown> = {};
  try {
    prior = JSON.parse(readFileSync(outPath, "utf8"));
  } catch {
    if (!process.env.USDC_ADDRESS || !process.env.REGISTRY_ADDRESS) {
      throw new Error(
        `No deployments/${chainId}.json found. Run the full deploy first, ` +
          `or set USDC_ADDRESS and REGISTRY_ADDRESS env vars.`,
      );
    }
  }

  const usdc = getAddress(
    (process.env.USDC_ADDRESS ?? (prior.usdc as string)) as Address,
  );
  const registry = getAddress(
    (process.env.REGISTRY_ADDRESS ?? (prior.registry as string)) as Address,
  );
  const releaseAuth = deployer.account.address as Address;

  console.log(`\nKajota Mesh — escrow-only upgrade on chainId ${chainId}`);
  console.log(`Deployer:  ${deployer.account.address}`);
  console.log(`USDC:      ${usdc}`);
  console.log(`Registry:  ${registry}  (reused — listings preserved)`);
  console.log(`Old escrow: ${prior.escrow ?? "(none)"}`);

  const balance = await publicClient.getBalance({
    address: deployer.account.address,
  });
  if (balance === 0n) {
    throw new Error("Deployer balance is 0 — fund it before deploying.");
  }

  console.log("\nDeploying upgraded CosellEscrow …");
  const escrow = await viem.deployContract("CosellEscrow", [
    usdc,
    registry,
    releaseAuth,
    releaseAuth, // arbiter (defaults to deployer; rotate via setArbiter)
    releaseAuth, // owner (defaults to deployer; transferOwnership later)
  ]);
  console.log(`  → CosellEscrow (buyer-confirm + dispute) @ ${escrow.address}\n`);

  const out = {
    ...prior,
    chainId,
    usdc,
    registry,
    releaseAuth,
    arbiter: releaseAuth,
    owner: releaseAuth,
    escrow: getAddress(escrow.address),
    prevEscrow: (prior.escrow as string) ?? null,
    escrowFeatures: "confirmReceipt + dispute/arbiter + RELEASE_GRACE + pausable",
    upgradedAt: new Date().toISOString(),
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath} (escrow updated; prevEscrow kept for reference)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
