/**
 * Deploys MockUSDC on a chain that has no canonical Circle USDC
 * (e.g. Mantle Sepolia) so CosellEscrow has an ERC20 to settle in.
 * Prints `MOCK_USDC=<address>` for piping into USDC_MANTLE_SEPOLIA.
 */
import { network } from "hardhat";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const chainId = await publicClient.getChainId();
  console.log(`MockUSDC deploy on chainId ${chainId}`);
  console.log(`Deployer: ${deployer.account.address}`);
  const balance = await publicClient.getBalance({
    address: deployer.account.address,
  });
  console.log(`Balance:  ${balance} wei`);
  if (balance === 0n) {
    throw new Error("Deployer balance is 0 — fund the EOA first.");
  }

  const mock = await viem.deployContract("MockUSDC");
  console.log(`MOCK_USDC=${mock.address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
