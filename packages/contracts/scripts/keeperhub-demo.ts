/**
 * KeeperHub demo pass — full escrow lifecycle end-to-end.
 *
 *   1. Register a listing on CosellRegistry (deployer = wholesaler).
 *   2. Approve CosellEscrow for USDC.
 *   3. Deposit USDC → capture depositId from the Deposited event.
 *   4. POST to KeeperHub workflow's HTTP trigger with that depositId.
 *   5. Poll executions until the release tx confirms.
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY  (from repo .env)
 *   KEEPERHUB_API_KEY     (kh_...)
 *   KEEPERHUB_WORKFLOW_ID (defaults to the pinned value in deployments/keeperhub.json)
 *   DEMO_COSELLER         (optional 0x…; defaults to a deterministic derived address)
 *   DEMO_GROSS_USDC       (optional human amount, defaults to 0.10)
 */
import { network } from "hardhat";
import {
  decodeEventLog,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { readFileSync } from "node:fs";
import path from "node:path";

const KH_BASE = "https://app.keeperhub.com";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();
  if (chainId !== 11155111) {
    throw new Error(`Wrong chain — expected 11155111 (Sepolia), got ${chainId}`);
  }

  const buyer = wallet.account.address as Address;

  const deploymentsPath = path.join(
    import.meta.dirname,
    "..",
    "deployments",
    "11155111.json",
  );
  const dep = JSON.parse(readFileSync(deploymentsPath, "utf8"));
  const registry = dep.registry as Address;
  const escrow = dep.escrow as Address;
  const usdc = dep.usdc as Address;

  const khPath = path.join(
    import.meta.dirname,
    "..",
    "deployments",
    "keeperhub.json",
  );
  const khCfg = JSON.parse(readFileSync(khPath, "utf8"));
  const workflowId =
    process.env.KEEPERHUB_WORKFLOW_ID ?? (khCfg.workflowId as string);
  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) {
    throw new Error(
      "KEEPERHUB_API_KEY not set — export kh_... before running this script.",
    );
  }

  console.log("Kajota × KeeperHub — end-to-end demo");
  console.log(`  Buyer / wholesaler: ${buyer}`);
  console.log(`  Registry:           ${registry}`);
  console.log(`  Escrow:             ${escrow}`);
  console.log(`  USDC:               ${usdc}`);
  console.log(`  KH workflowId:      ${workflowId}`);

  const productId = `KH-DEMO-${Math.floor(Date.now() / 1000)}`;
  const coseller: Address =
    (process.env.DEMO_COSELLER as Address | undefined) ??
    ("0x000000000000000000000000000000000000dEaD" as Address);
  const commissionBps = 1500;
  const currency = "USD";

  const humanAmount = process.env.DEMO_GROSS_USDC ?? "0.10";
  const grossAmount = parseUnits(humanAmount, 6);
  console.log(
    `  Listing:            productId="${productId}" coseller=${coseller} bps=${commissionBps}`,
  );
  console.log(`  Amount:             ${humanAmount} USDC (${grossAmount} raw)`);

  // -------------------------------------------------------------
  // 1. Register listing
  // -------------------------------------------------------------
  const registerAbi = [
    {
      type: "function",
      name: "register",
      stateMutability: "nonpayable",
      inputs: [
        { name: "productId", type: "string" },
        { name: "wholesaler", type: "address" },
        { name: "coseller", type: "address" },
        { name: "commissionBps", type: "uint16" },
        { name: "currency", type: "string" },
      ],
      outputs: [{ name: "listingId", type: "bytes32" }],
    },
    {
      type: "function",
      name: "computeListingId",
      stateMutability: "pure",
      inputs: [
        { name: "productId", type: "string" },
        { name: "wholesaler", type: "address" },
        { name: "coseller", type: "address" },
      ],
      outputs: [{ name: "", type: "bytes32" }],
    },
  ] as const;

  const listingId = (await publicClient.readContract({
    address: registry,
    abi: registerAbi,
    functionName: "computeListingId",
    args: [productId, buyer, coseller],
  })) as Hex;
  console.log(`\n[1/5] register(${productId}) → listingId=${listingId}`);

  const regHash = await wallet.writeContract({
    address: registry,
    abi: registerAbi,
    functionName: "register",
    args: [productId, buyer, coseller, commissionBps, currency],
  });
  const regRcpt = await publicClient.waitForTransactionReceipt({ hash: regHash });
  console.log(`      tx=${regHash} block=${regRcpt.blockNumber}`);

  // -------------------------------------------------------------
  // 2. Approve USDC
  // -------------------------------------------------------------
  const erc20Abi = [
    {
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [
        { name: "spender", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
    },
    {
      type: "function",
      name: "allowance",
      stateMutability: "view",
      inputs: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
      ],
      outputs: [{ name: "", type: "uint256" }],
    },
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as const;

  const balance = (await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [buyer],
  })) as bigint;
  if (balance < grossAmount) {
    throw new Error(
      `USDC balance ${formatUnits(balance, 6)} < required ${humanAmount}. Top up at faucet.circle.com.`,
    );
  }
  console.log(`\n[2/5] approve(escrow=${escrow}, ${humanAmount} USDC)`);
  const appHash = await wallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [escrow, grossAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: appHash });
  console.log(`      tx=${appHash}`);

  // -------------------------------------------------------------
  // 3. Deposit + capture depositId from event
  // -------------------------------------------------------------
  const escrowAbi = [
    {
      type: "function",
      name: "deposit",
      stateMutability: "nonpayable",
      inputs: [
        { name: "listingId", type: "bytes32" },
        { name: "grossAmount", type: "uint256" },
      ],
      outputs: [{ name: "depositId", type: "bytes32" }],
    },
    {
      type: "event",
      name: "Deposited",
      inputs: [
        { name: "depositId", type: "bytes32", indexed: true },
        { name: "listingId", type: "bytes32", indexed: true },
        { name: "buyer", type: "address", indexed: true },
        { name: "grossAmount", type: "uint256", indexed: false },
      ],
    },
    {
      type: "event",
      name: "Released",
      inputs: [
        { name: "depositId", type: "bytes32", indexed: true },
        { name: "listingId", type: "bytes32", indexed: true },
        { name: "wholesaler", type: "address", indexed: false },
        { name: "coseller", type: "address", indexed: false },
        { name: "wholesalerShare", type: "uint256", indexed: false },
        { name: "cosellerShare", type: "uint256", indexed: false },
      ],
    },
  ] as const;

  console.log(`\n[3/5] deposit(listingId, ${grossAmount})`);
  const depHash = await wallet.writeContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "deposit",
    args: [listingId, grossAmount],
  });
  const depRcpt = await publicClient.waitForTransactionReceipt({ hash: depHash });

  let depositId: Hex | undefined;
  for (const log of depRcpt.logs) {
    if (log.address.toLowerCase() !== escrow.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: escrowAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "Deposited") {
        depositId = (decoded.args as { depositId: Hex }).depositId;
        break;
      }
    } catch {
      // skip non-matching logs
    }
  }
  if (!depositId) throw new Error("Deposited event not found in receipt");
  console.log(`      tx=${depHash}`);
  console.log(`      depositId=${depositId}`);

  // -------------------------------------------------------------
  // 4. POST to KeeperHub workflow
  // -------------------------------------------------------------
  console.log(`\n[4/5] KeeperHub POST /api/workflows/${workflowId}/execute`);
  const execRes = await fetch(
    `${KH_BASE}/api/workflows/${workflowId}/execute`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: { depositId } }),
    },
  );
  const execBody = await execRes.json();
  if (!execRes.ok) {
    throw new Error(
      `KH execute HTTP ${execRes.status}: ${JSON.stringify(execBody)}`,
    );
  }
  console.log(`      executionId=${execBody.executionId} status=${execBody.status}`);

  // -------------------------------------------------------------
  // 5. Poll KH executions until terminal, then verify Released event
  // -------------------------------------------------------------
  console.log(`\n[5/5] polling KH execution + Sepolia release tx …`);
  let terminal: any = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 90_000) {
    await new Promise((r) => setTimeout(r, 3000));
    const listRes = await fetch(
      `${KH_BASE}/api/workflows/${workflowId}/executions`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const runs = await listRes.json();
    const run = (runs as any[]).find((r) => r.id === execBody.executionId);
    if (!run) continue;
    process.stdout.write(
      `      [${((Date.now() - startedAt) / 1000).toFixed(0)}s] status=${run.status}\n`,
    );
    if (run.status !== "running" && run.status !== "pending") {
      terminal = run;
      break;
    }
  }
  if (!terminal) throw new Error("KH execution did not reach a terminal state in 90s");

  console.log(`\n=== KeeperHub terminal ===`);
  console.log(`  status:            ${terminal.status}`);
  console.log(`  duration:          ${terminal.duration}ms`);
  console.log(
    `  transactionHashes: ${JSON.stringify(terminal.transactionHashes)}`,
  );
  console.log(`  gasUsedWei:        ${terminal.gasUsedWei}`);
  if (terminal.error) console.log(`  error:             ${terminal.error}`);

  // KeeperHub returns entries shaped either as bare hex strings or
  // { hash, nodeId, nodeName } depending on runtime version.
  const txEntries: Array<Hex | { hash: Hex; nodeId?: string; nodeName?: string }> =
    terminal.transactionHashes ?? [];
  const txHashes: Hex[] = txEntries.map((e) =>
    typeof e === "string" ? e : (e.hash as Hex),
  );
  if (txHashes.length === 0 && terminal.status !== "success") {
    throw new Error(
      "Workflow did not submit a release tx. Full record:\n" +
        JSON.stringify(terminal, null, 2),
    );
  }

  // Confirm the release tx has actually mined + emitted Released
  for (const hash of txHashes) {
    console.log(`\n  Sepolia tx: https://sepolia.etherscan.io/tx/${hash}`);
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `  status=${rcpt.status} block=${rcpt.blockNumber} gasUsed=${rcpt.gasUsed}`,
    );
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== escrow.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: escrowAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "Released") {
          console.log(`  Released event:`);
          console.log(JSON.stringify(decoded.args, replacer, 4));
        }
      } catch {}
    }
  }
  console.log("\nDone. End-to-end path proven.");
}

function replacer(_: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
