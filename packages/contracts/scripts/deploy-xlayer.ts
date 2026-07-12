/**
 * Deploy script for Kajota Mesh contracts on XLayer testnet (chainId 195).
 *
 * XLayer (OKX's Polygon-CDK L2) testnet does not have a widely-published,
 * faucet-accessible ERC20 stablecoin at a 6-decimal fixed address the way
 * Circle publishes USDC on Base Sepolia / Ethereum Sepolia. Rather than
 * couple our submission to a third-party token whose address may shift,
 * this script deploys `MockUSDC` — the same 6-decimal ERC20 the escrow
 * tests exercise — as our own testnet stablecoin ("KaJota USD" for the
 * demo), then hands its address to the regular registry + escrow
 * deployment flow.
 *
 * Usage:
 *   pnpm --filter @kajota-mesh/contracts deploy:xlayer-testnet-with-mock
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY  — funded with XLayer testnet OKB from
 *                           https://web3.okx.com/xlayer/faucet
 *   INITIAL_RELEASE_AUTH  — optional; defaults to deployer
 *
 * Output:
 *   - prints deployed addresses to stdout
 *   - writes deployments/195.json alongside the other chains' records
 *
 * OKX.AI Genesis Hackathon (Jul 8–17, 2026). Kept separate from the
 * canonical `scripts/deploy.ts` because that script expects a real Circle
 * USDC address on every non-Ethereum-Sepolia chain and would need to grow
 * an auto-mock branch. This script keeps the L1 path untouched.
 */
import { network } from "hardhat";
import { getAddress, type Address, parseUnits } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const chainId = await publicClient.getChainId();
  const chainName =
    publicClient.chain?.name ??
    (chainId === 195 ? "XLayer Testnet" : `chain-${chainId}`);

  console.log(`\nKajota Mesh — XLayer deploy on ${chainName} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.account.address}`);
  const balance = await publicClient.getBalance({
    address: deployer.account.address,
  });
  console.log(`Balance:  ${balance} wei OKB`);
  if (balance === 0n) {
    throw new Error(
      "Deployer OKB balance is 0 — drip from https://web3.okx.com/xlayer/faucet before retrying.",
    );
  }

  // ---- 1. MockUSDC (our testnet "KaJota USD" 6-decimal stablecoin) ----
  console.log("\nDeploying MockUSDC (KaJota USD, 6-decimal ERC20) …");
  const usdc = await viem.deployContract("MockUSDC");
  const usdcAddress = getAddress(usdc.address) as Address;
  console.log(`  → MockUSDC       @ ${usdcAddress}`);

  // Mint a demo float to the deployer so the end-to-end escrow flow can
  // actually run in the demo video without a separate seed step. 100_000
  // KJUSD (six decimals) = 100_000e6.
  const mintAmount = parseUnits("100000", 6);
  console.log(`  → Minting ${mintAmount} base units to deployer …`);
  await usdc.write.mint([deployer.account.address, mintAmount]);

  // ---- 2. releaseAuth --------------------------------------------------
  const releaseAuthEnv = process.env.INITIAL_RELEASE_AUTH;
  const releaseAuth: Address =
    releaseAuthEnv && releaseAuthEnv.length > 0
      ? (getAddress(releaseAuthEnv) as Address)
      : (deployer.account.address as Address);
  console.log(`Release:  ${releaseAuth}\n`);

  // ---- 3. CosellRegistry ----------------------------------------------
  console.log("Deploying CosellRegistry …");
  const registry = await viem.deployContract("CosellRegistry");
  console.log(`  → CosellRegistry @ ${registry.address}`);

  // ---- 4. CosellEscrow ------------------------------------------------
  console.log("Deploying CosellEscrow …");
  const escrow = await viem.deployContract("CosellEscrow", [
    usdcAddress,
    registry.address,
    releaseAuth,
  ]);
  console.log(`  → CosellEscrow   @ ${escrow.address}\n`);

  // ---- 5. Persist addresses -------------------------------------------
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
    usdcSymbol: "KJUSD",
    usdcNote: "MockUSDC deployed for OKX.AI Genesis submission — 6-decimal ERC20",
    releaseAuth,
    registry: registry.address,
    escrow: escrow.address,
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(deploymentsDir, `${chainId}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);

  console.log("\nDone. Next steps:");
  console.log("  1. Inspect on OKLink:");
  console.log(`     https://www.oklink.com/x-layer-testnet/address/${escrow.address}`);
  console.log("  2. Set in Coach's .env:");
  console.log(`     MESH_RPC_URL=https://testrpc.xlayer.tech`);
  console.log(`     MESH_CHAIN_ID=195`);
  console.log(`     MESH_ESCROW_ADDR=${escrow.address}`);
  console.log(`     MESH_REGISTRY_ADDR=${registry.address}`);
  console.log(`     MESH_USDC_ADDR=${usdcAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
