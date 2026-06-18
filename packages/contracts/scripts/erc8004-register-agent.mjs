/**
 * Register the Kajota Coach Agent as an ERC-8004 "Trustless Agent" on
 * Mantle Sepolia — mints the agent's on-chain identity NFT against the
 * canonical IdentityRegistry singleton (no deploy required).
 *
 * Hits two of the hackathon's three pillars at once:
 *   - ERC-8004 agent identity (pillar 2): the agent gets a real agentId
 *     + identity NFT, browsable in any ERC-721 / agent explorer.
 *   - on-chain record (pillar 1): the AgentCard + registration live
 *     on-chain, permanently.
 *
 * What it does:
 *   1. reads ../agents/kajota-coach-agent.json (the AgentCard)
 *   2. register(agentURI) on the IdentityRegistry -> agentId  (tx 1)
 *   3. backfills the real agentId into the card and setAgentURI(...) so
 *      the registration self-reference is correct                (tx 2, best-effort)
 *
 * agentURI: by default the AgentCard is embedded as a self-contained
 * `data:application/json;base64,...` URI (no hosting needed — the repos
 * are private). Override with a public https/ipfs URL via AGENT_URI=...
 *
 * Run:  cd packages/contracts && node scripts/erc8004-register-agent.mjs
 * Env (repo-root .env): DEPLOYER_PRIVATE_KEY, MANTLE_SEPOLIA_RPC
 */
import { readFileSync } from "node:fs";
import {
  createWalletClient,
  createPublicClient,
  http,
  getAddress,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// --- secrets from repo-root .env (never printed) ---
const env = Object.fromEntries(
  readFileSync(new URL("../../../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const rpc = env.MANTLE_SEPOLIA_RPC || "https://rpc.sepolia.mantle.xyz";
let pk = env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not found in .env");
if (!pk.startsWith("0x")) pk = "0x" + pk;

const account = privateKeyToAccount(pk);

// Canonical ERC-8004 IdentityRegistry on Mantle Sepolia (verified live, chainId 5003).
const IDENTITY_REGISTRY = getAddress("0x8004A818BFB912233c491871b3d84c89A494BD9e");

const ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
];

const card = JSON.parse(
  readFileSync(new URL("../agents/kajota-coach-agent.json", import.meta.url), "utf8")
);
const toDataUri = (obj) =>
  "data:application/json;base64," + Buffer.from(JSON.stringify(obj)).toString("base64");

const overrideUri = env.AGENT_URI || process.env.AGENT_URI || "";
const registerUri = overrideUri || toDataUri(card);

const pub = createPublicClient({ transport: http(rpc) });
const wallet = createWalletClient({ account, transport: http(rpc) });

console.log("chain      : Mantle Sepolia (5003)");
console.log("registry   :", IDENTITY_REGISTRY, "(ERC-8004 IdentityRegistry)");
console.log("signer     :", account.address);
console.log("agent      :", card.name);
console.log("agentURI   :", overrideUri ? overrideUri : `data:application/json;base64,… (${registerUri.length} chars, self-contained)`);
console.log("simulating register()…");

const { request, result: simAgentId } = await pub.simulateContract({
  account,
  address: IDENTITY_REGISTRY,
  abi: ABI,
  functionName: "register",
  args: [registerUri],
});
console.log("simulate OK → agentId (predicted):", simAgentId.toString());

const hash1 = await wallet.writeContract(request);
console.log("register tx:", hash1, "— waiting…");
const r1 = await pub.waitForTransactionReceipt({ hash: hash1 });

// confirm agentId from the Registered event
let agentId = simAgentId;
for (const lg of r1.logs) {
  if (getAddress(lg.address) !== IDENTITY_REGISTRY) continue;
  try {
    const ev = decodeEventLog({ abi: ABI, data: lg.data, topics: lg.topics });
    if (ev.eventName === "Registered") { agentId = ev.args.agentId; break; }
  } catch {}
}

console.log("------------------------------------------------------------");
console.log("status     :", r1.status);
console.log("block      :", r1.blockNumber.toString());
console.log("agentId    :", agentId.toString(), "  ← the Coach Agent's ERC-8004 identity");
console.log("owner      :", account.address);
console.log("register tx:", hash1);
console.log("explorer   : https://explorer.sepolia.mantle.xyz/tx/" + hash1);

// --- tx 2 (best-effort): backfill the real agentId into the card ---
if (!overrideUri) {
  try {
    const finalCard = JSON.parse(JSON.stringify(card));
    finalCard.registrations[0].agentId = Number(agentId);
    const finalUri = toDataUri(finalCard);
    console.log("\nbackfilling agentId into AgentCard via setAgentURI()…");
    const { request: req2 } = await pub.simulateContract({
      account, address: IDENTITY_REGISTRY, abi: ABI,
      functionName: "setAgentURI", args: [agentId, finalUri],
    });
    const hash2 = await wallet.writeContract(req2);
    const r2 = await pub.waitForTransactionReceipt({ hash: hash2 });
    console.log("setAgentURI:", r2.status, "tx:", hash2);
    console.log("explorer   : https://explorer.sepolia.mantle.xyz/tx/" + hash2);
  } catch (e) {
    console.log("setAgentURI skipped (mint already succeeded):", e.shortMessage || e.message);
    console.log("→ card is registered; agentId self-ref can be backfilled later if desired.");
  }
}

// final read-back
try {
  const uri = await pub.readContract({
    address: IDENTITY_REGISTRY, abi: ABI, functionName: "tokenURI", args: [agentId],
  });
  console.log("\ntokenURI(", agentId.toString(), ") =", uri.slice(0, 80) + (uri.length > 80 ? "…" : ""));
} catch {}

console.log("\n✅ Coach Agent is now an ERC-8004 agent on Mantle: agentId", agentId.toString());
