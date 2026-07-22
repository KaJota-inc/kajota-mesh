/**
 * Rotate `releaseAuth` on the deployed CosellEscrow.
 *
 * The KeeperHub hackathon submission hands escrow release over to a
 * KeeperHub-managed Turnkey wallet: when off-chain delivery attestation
 * fires, KeeperHub's `web3/write-contract` action calls
 * `CosellEscrow.release(depositId)` on Sepolia. That call is gated by
 * `msg.sender == releaseAuth`, so we point releaseAuth at the KeeperHub
 * wallet before the demo.
 *
 * Only the *current* releaseAuth can rotate it (see
 * `CosellEscrow.setReleaseAuth`), so run this with the deployer key that
 * initially set it.
 *
 * Usage:
 *   NEXT_RELEASE_AUTH=0x… pnpm --filter @kajota-mesh/contracts \
 *     set-release-auth:sepolia
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   — must currently hold releaseAuth
 *   NEXT_RELEASE_AUTH      — the KeeperHub Turnkey wallet address
 */
import { network } from "hardhat";
import { getAddress, type Address } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [signer] = await viem.getWalletClients();

  const chainId = await publicClient.getChainId();
  console.log(`\nsetReleaseAuth on chainId ${chainId}`);
  console.log(`Signer: ${signer.account.address}`);

  const deploymentsDir = path.resolve(
    import.meta.dirname,
    "..",
    "deployments",
  );
  const deploymentPath = path.join(deploymentsDir, `${chainId}.json`);
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as {
    escrow: string;
    releaseAuth: string;
    [k: string]: unknown;
  };
  const escrowAddress = getAddress(deployment.escrow) as Address;
  console.log(`Escrow: ${escrowAddress}`);
  console.log(`Current releaseAuth (per file): ${deployment.releaseAuth}`);

  const nextEnv = process.env.NEXT_RELEASE_AUTH;
  if (!nextEnv) {
    throw new Error(
      "NEXT_RELEASE_AUTH is required (the KeeperHub Turnkey wallet address).",
    );
  }
  const next = getAddress(nextEnv) as Address;
  console.log(`Next releaseAuth:               ${next}`);

  const escrow = await viem.getContractAt("CosellEscrow", escrowAddress);
  const onchainCurrent = (await escrow.read.releaseAuth()) as Address;
  console.log(`Current releaseAuth (on-chain): ${onchainCurrent}`);
  if (getAddress(onchainCurrent) !== getAddress(signer.account.address)) {
    throw new Error(
      `Signer ${signer.account.address} is not the current releaseAuth (${onchainCurrent}). Only the current releaseAuth can rotate.`,
    );
  }
  if (getAddress(onchainCurrent) === next) {
    console.log("releaseAuth already matches — nothing to do.");
    return;
  }

  console.log("\nSending setReleaseAuth …");
  const txHash = await escrow.write.setReleaseAuth([next]);
  console.log(`  tx: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`setReleaseAuth reverted (${txHash})`);
  }
  console.log(`  status: ${receipt.status} (block ${receipt.blockNumber})`);

  const updated = {
    ...deployment,
    releaseAuth: next,
    releaseAuthUpdatedAt: new Date().toISOString(),
    releaseAuthUpdateTx: txHash,
  };
  writeFileSync(deploymentPath, JSON.stringify(updated, null, 2) + "\n");
  console.log(`\nWrote ${deploymentPath}`);
  console.log("Done. releaseAuth is now the KeeperHub keeper.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
