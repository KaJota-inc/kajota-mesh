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
    // Ethereum Sepolia — the chain Google Cloud's Web3 faucet drips
    // to by default. Chainlink Functions is supported here
    // (DON id: fun-ethereum-sepolia-1), so the full Mesh flow runs
    // the same as on Base Sepolia.
    sepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: deployerAccounts,
      chainId: 11155111,
    },
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
    // Arbitrum Sepolia — target for Arbitrum Open House London buildathon
    // (Jun 14, 2026 deadline). EVM-equivalent, so the same bytecode used
    // on Ethereum Sepolia ports cleanly. Circle USDC is live here
    // (0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d) and Chainlink Functions
    // is supported (DON id: fun-arbitrum-sepolia-1).
    arbitrumSepolia: {
      type: "http",
      chainType: "l1",
      url:
        process.env.ARBITRUM_SEPOLIA_RPC ??
        "https://sepolia-rollup.arbitrum.io/rpc",
      accounts: deployerAccounts,
      chainId: 421614,
    },
  },
  // Etherscan V2 unified API — one key from etherscan.io/arbiscan.io
  // covers every chain id. Required for `pnpm hardhat verify`.
  verify: {
    etherscan: {
      apiKey: process.env.ARBISCAN_API_KEY ?? "",
    },
  },
};

export default config;
