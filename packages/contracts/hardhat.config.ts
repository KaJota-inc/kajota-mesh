import type { HardhatUserConfig } from "hardhat/config";
import HardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

/**
 * Hardhat 3 config for Kajota Mesh contracts.
 *
 * Networks (target chains):
 *  - Base Sepolia — primary testnet target. Chainlink Functions are
 *    supported on Base Sepolia (FUN-CHAINID-1). USDC is available
 *    via Circle's testnet faucet.
 *  - Mantle Sepolia — Mantle Turing Test Phase 2 secondary target;
 *    deploy the same bytecode if/when we cross-target.
 *  - Local (built-in EDR / Hardhat node) — what `pnpm test` uses.
 *
 * Compiler config inherits Concierge's choice (0.8.24, Cancun) so the
 * two sibling repos share a vendored OZ baseline.
 */
const config: HardhatUserConfig = {
  plugins: [HardhatToolboxViem],
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        settings: {
          // OpenZeppelin >= 5.1 uses `mcopy`, a Cancun opcode. 0.8.24
          // supports it but defaults to Paris — opt in explicitly.
          // Base Sepolia is Cancun-capable; verify Mantle Sepolia
          // before the cross-chain deploy.
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
};

export default config;
