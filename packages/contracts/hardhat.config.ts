import type { HardhatUserConfig } from "hardhat/config";
import HardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

/**
 * Hardhat 3 config for Kajota Mesh contracts.
 *
 * Networks (target chains):
 *  - Base Sepolia — primary testnet target. Chainlink Functions are
 *    supported on Base Sepolia (DON id: fun-base-sepolia-1). USDC is
 *    available via Circle's testnet faucet (0x036CbD…dCF7e).
 *  - Mantle Sepolia — Mantle Turing Test Phase 2 secondary target;
 *    same bytecode deploys.
 *  - Local (built-in EDR / Hardhat node) — what `pnpm test` uses.
 *
 * RPCs + private key are env-gated. Run `cp ../../.env.example
 * ../../.env` at the repo root and fill in `DEPLOYER_PRIVATE_KEY`
 * before running any `deploy:*` script.
 */

// Hardhat 3's TS config doesn't auto-load .env, so do it explicitly.
// `dotenv` ships with @nomicfoundation/hardhat-toolbox-viem.
import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv({ path: path.resolve(import.meta.dirname, "../../.env") });

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const deployerAccounts =
  DEPLOYER_KEY && DEPLOYER_KEY.startsWith("0x") ? [DEPLOYER_KEY] : [];

const config: HardhatUserConfig = {
  plugins: [HardhatToolboxViem],
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        settings: {
          // OZ >= 5.1 uses `mcopy` (Cancun). 0.8.24 supports it but
          // defaults to Paris — opt in explicitly. Base Sepolia is
          // Cancun-capable; Mantle Sepolia is Shanghai-capable, but
          // we are not yet using mcopy-emitting OZ utilities in a
          // hot path, so the bytecode is portable today.
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    baseSepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org",
      accounts: deployerAccounts,
      chainId: 84532,
    },
    mantleSepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.MANTLE_SEPOLIA_RPC ?? "https://rpc.sepolia.mantle.xyz",
      accounts: deployerAccounts,
      chainId: 5003,
    },
  },
};

export default config;
