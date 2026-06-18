#!/usr/bin/env node
/**
 * Kajota Mesh + ERC-8004 — LIVE on-chain watcher (demo companion).
 *
 * Side-by-side terminal for the Coach app. Watches TWO chains so all three
 * Mantle "Turing Test" pillars are observable the instant they happen:
 *
 *   Ethereum Sepolia · Mesh
 *     - CosellRegistry   ListingRegistered / ListingDeactivated
 *     - CosellEscrow     Deposited / Released / Refunded
 *
 *   Mantle Sepolia · ERC-8004  (the three defining pillars)
 *     - IdentityRegistry    Registered    → pillar 2: agent identity NFT
 *     - ReputationRegistry  NewFeedback   → pillar 1: on-chain agent-run benchmark
 *     (pillar 3: it's all live + links to the Mantle explorer — verifiable)
 *
 * The moment the app records a run on Mantle ("Benchmark this run"), this
 * panel prints the decoded NewFeedback event — a live, verifiable benchmark
 * of agent #303.
 *
 *   cd packages/contracts        # viem resolves here in this workspace
 *   node scripts/mesh-demo-watch.mjs
 *
 * Optional env:
 *   RPC_URL=...         override the Ethereum Sepolia RPC
 *   MANTLE_RPC_URL=...  override the Mantle Sepolia RPC
 *   POLL_MS=4000        poll interval in ms
 *   HISTORY=3           recent items to show per source on startup
 *
 * Zero config needed — the live contract addresses are baked in.
 */
import { createPublicClient, http, parseAbiItem, formatUnits, getAddress } from 'viem';

/* ----------------------------- config ------------------------------ */

const POLL_MS = Number(process.env.POLL_MS || 4000);
const HISTORY = Number(process.env.HISTORY || 3);

// Ethereum Sepolia · Mesh
const ETH_RPC = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const ETH_CHAIN_ID = 11155111;
const ETH_EXPLORER = 'https://sepolia.etherscan.io';
const REGISTRY = '0xfce6bd68d8d6f858d447f537d206c1e354b44315';
const ESCROW = '0x599869cef2e4c52e2c9074caaf8f9fb0cb191776';
const USDC_DECIMALS = 6;

// Mantle Sepolia · ERC-8004 (canonical singletons)
const MANTLE_RPC = process.env.MANTLE_RPC_URL || 'https://rpc.sepolia.mantle.xyz';
const MANTLE_CHAIN_ID = 5003;
const MANTLE_EXPLORER = 'https://explorer.sepolia.mantle.xyz';
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const COACH_AGENT_ID = 303n;

/* ----------------------------- abis -------------------------------- */

// Mesh (Ethereum Sepolia)
const evListingRegistered = parseAbiItem(
  'event ListingRegistered(bytes32 indexed listingId, string indexed productId, address indexed wholesaler, address coseller, uint16 commissionBps, string currency)',
);
const evListingDeactivated = parseAbiItem(
  'event ListingDeactivated(bytes32 indexed listingId, address indexed by)',
);
const evDeposited = parseAbiItem(
  'event Deposited(bytes32 indexed depositId, bytes32 indexed listingId, address indexed buyer, uint256 grossAmount)',
);
const evReleased = parseAbiItem(
  'event Released(bytes32 indexed depositId, bytes32 indexed listingId, address wholesaler, address coseller, uint256 wholesalerShare, uint256 cosellerShare)',
);
const evRefunded = parseAbiItem(
  'event Refunded(bytes32 indexed depositId, address indexed buyer, uint256 grossAmount)',
);
const registryEvents = [evListingRegistered, evListingDeactivated];
const escrowEvents = [evDeposited, evReleased, evRefunded];

// ERC-8004 (Mantle Sepolia)
const evAgentRegistered = parseAbiItem(
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
);
const evNewFeedback = parseAbiItem(
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
);

const getListingAbi = [
  {
    type: 'function',
    name: 'getListing',
    stateMutability: 'view',
    inputs: [{ name: 'listingId', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'productId', type: 'string' },
          { name: 'wholesaler', type: 'address' },
          { name: 'coseller', type: 'address' },
          { name: 'commissionBps', type: 'uint16' },
          { name: 'currency', type: 'string' },
          { name: 'registeredAt', type: 'uint64' },
          { name: 'active', type: 'bool' },
        ],
      },
    ],
  },
];

const identityReadAbi = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'string' }] },
];

/* --------------------------- ansi helpers -------------------------- */

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  gray: '\x1b[90m', orange: '\x1b[38;5;208m', purple: '\x1b[38;5;141m',
};
const paint = (s, ...codes) => codes.join('') + s + C.reset;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const now = () => new Date().toLocaleTimeString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- clients ----------------------------- */

const ethClient = createPublicClient({ transport: http(ETH_RPC) });
const mantleClient = createPublicClient({ transport: http(MANTLE_RPC) });

/* ----------------------------- render ------------------------------ */

function banner() {
  const line = '═'.repeat(58);
  console.log(paint(`╔${line}╗`, C.orange, C.bold));
  console.log(paint('║', C.orange, C.bold) +
    paint('   🔗  KAJOTA MESH + ERC-8004  ·  LIVE ON-CHAIN WATCHER  ', C.bold, C.white) +
    paint('║', C.orange, C.bold));
  console.log(paint(`╚${line}╝`, C.orange, C.bold));
  console.log(`${paint('Mesh', C.gray)}      ${paint(`Ethereum Sepolia (${ETH_CHAIN_ID})`, C.white)}  registry ${paint(short(REGISTRY), C.cyan)}  escrow ${paint(short(ESCROW), C.cyan)}`);
  console.log(`${paint('ERC-8004', C.gray)}  ${paint(`Mantle Sepolia (${MANTLE_CHAIN_ID})`, C.purple)}  identity ${paint(short(IDENTITY_REGISTRY), C.cyan)}  reputation ${paint(short(REPUTATION_REGISTRY), C.cyan)}`);
  console.log('');
}

/* ---- mesh (Ethereum Sepolia) ---- */

async function enrichListing(listingId) {
  try {
    return await ethClient.readContract({
      address: REGISTRY, abi: getListingAbi, functionName: 'getListing', args: [listingId],
    });
  } catch {
    return null;
  }
}

async function renderRegistered(log, { fresh } = { fresh: false }) {
  const l = await enrichListing(log.args.listingId);
  const head = fresh
    ? paint('  🟢  NEW LISTING REGISTERED ', C.bold, C.green) + paint(`· ${now()}`, C.gray)
    : paint('  •  listing ', C.dim);
  console.log('');
  console.log(head);
  const pct = Number(log.args.commissionBps) / 100;
  const product = l ? l.productId : paint('(indexed — see tx)', C.dim);
  const coseller = l ? l.coseller : log.args.coseller;
  console.log(`     ${paint('product', C.gray)}    ${paint(product, C.bold, C.white)}`);
  console.log(`     ${paint('wholesaler', C.gray)} ${paint(getAddress(log.args.wholesaler), C.white)}  ${paint('(signer / seller)', C.dim)}`);
  console.log(`     ${paint('co-seller', C.gray)}  ${paint(getAddress(coseller), C.white)}`);
  console.log(`     ${paint('commission', C.gray)} ${paint(`${pct}%`, C.bold, C.yellow)} ${paint(`(${log.args.commissionBps} bps)`, C.gray)}   ${paint('currency', C.gray)} ${l ? l.currency : ''}`);
  console.log(`     ${paint('listingId', C.gray)}  ${paint(log.args.listingId, C.magenta)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${ETH_EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderDeactivated(log) {
  console.log('');
  console.log(paint('  🟡  LISTING DEACTIVATED ', C.bold, C.yellow) + paint(`· ${now()}`, C.gray));
  console.log(`     ${paint('listingId', C.gray)}  ${paint(log.args.listingId, C.magenta)}`);
  console.log(`     ${paint('by', C.gray)}         ${getAddress(log.args.by)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${ETH_EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderDeposited(log) {
  console.log('');
  console.log(paint('  💰  ESCROW DEPOSIT ', C.bold, C.cyan) + paint(`· ${now()}`, C.gray));
  console.log(`     ${paint('listingId', C.gray)}  ${paint(log.args.listingId, C.magenta)}`);
  console.log(`     ${paint('buyer', C.gray)}      ${getAddress(log.args.buyer)}`);
  console.log(`     ${paint('amount', C.gray)}     ${paint(`${formatUnits(log.args.grossAmount, USDC_DECIMALS)} USDC`, C.bold, C.cyan)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${ETH_EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderReleased(log) {
  console.log('');
  console.log(paint('  ✅  ESCROW RELEASED (auto-split) ', C.bold, C.green) + paint(`· ${now()}`, C.gray));
  console.log(`     ${paint('listingId', C.gray)}  ${paint(log.args.listingId, C.magenta)}`);
  console.log(`     ${paint('→ wholesaler', C.gray)} ${paint(`${formatUnits(log.args.wholesalerShare, USDC_DECIMALS)} USDC`, C.bold, C.white)}  ${short(getAddress(log.args.wholesaler))}`);
  console.log(`     ${paint('→ co-seller', C.gray)}  ${paint(`${formatUnits(log.args.cosellerShare, USDC_DECIMALS)} USDC`, C.bold, C.green)}  ${short(getAddress(log.args.coseller))}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${ETH_EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderRefunded(log) {
  console.log('');
  console.log(paint('  ↩️   ESCROW REFUNDED ', C.bold, C.orange) + paint(`· ${now()}`, C.gray));
  console.log(`     ${paint('buyer', C.gray)}      ${getAddress(log.args.buyer)}`);
  console.log(`     ${paint('amount', C.gray)}     ${paint(`${formatUnits(log.args.grossAmount, USDC_DECIMALS)} USDC`, C.bold, C.orange)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${ETH_EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

/* ---- ERC-8004 (Mantle Sepolia) ---- */

function decodeAgentName(uri) {
  try {
    if (typeof uri === 'string' && uri.startsWith('data:')) {
      const json = JSON.parse(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8'));
      if (json?.name) return json.name;
    }
  } catch { /* ignore */ }
  return null;
}

function renderAgentRegistered(log, { fresh } = { fresh: false }) {
  const head = fresh
    ? paint('  🆔  ERC-8004 AGENT REGISTERED ', C.bold, C.purple) + paint(`· ${now()}`, C.gray)
    : paint('  •  agent ', C.dim);
  const name = decodeAgentName(log.args.agentURI);
  console.log('');
  console.log(head);
  console.log(`     ${paint('agentId', C.gray)}    ${paint(`#${log.args.agentId}`, C.bold, C.white)}${name ? '  ' + paint(name, C.white) : ''}`);
  console.log(`     ${paint('owner', C.gray)}      ${paint(getAddress(log.args.owner), C.white)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${MANTLE_EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderFeedback(log, { fresh } = { fresh: false }) {
  const head = fresh
    ? paint('  📊  AGENT RUN BENCHMARKED ', C.bold, C.green) + paint(`· ${now()}`, C.gray)
    : paint('  •  benchmark ', C.dim);
  const dec = Number(log.args.valueDecimals || 0);
  const raw = log.args.value;
  const score = dec === 0 ? `${raw}` : `${Number(raw) / 10 ** dec}`;
  console.log('');
  console.log(head);
  console.log(`     ${paint('agent', C.gray)}      ${paint(`#${log.args.agentId}`, C.bold, C.white)}   ${paint('score', C.gray)} ${paint(score, C.bold, C.yellow)}`);
  console.log(`     ${paint('tags', C.gray)}       ${paint(`${log.args.tag1}${log.args.tag2 ? ' · ' + log.args.tag2 : ''}`, C.white)}`);
  console.log(`     ${paint('client', C.gray)}     ${paint(getAddress(log.args.clientAddress), C.white)}  ${paint('(rated the agent)', C.dim)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${MANTLE_EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

async function render(log, fresh) {
  switch (log.eventName) {
    case 'ListingRegistered': return renderRegistered(log, { fresh });
    case 'ListingDeactivated': return renderDeactivated(log);
    case 'Deposited': return renderDeposited(log);
    case 'Released': return renderReleased(log);
    case 'Refunded': return renderRefunded(log);
    case 'Registered': return renderAgentRegistered(log, { fresh });
    case 'NewFeedback': return renderFeedback(log, { fresh });
    default: return undefined;
  }
}

/* ------------------------------ logs ------------------------------- */

async function getMeshEvents(fromBlock, toBlock) {
  const [reg, esc] = await Promise.all([
    ethClient.getLogs({ address: REGISTRY, events: registryEvents, fromBlock, toBlock }),
    ethClient.getLogs({ address: ESCROW, events: escrowEvents, fromBlock, toBlock }),
  ]);
  return sortLogs([...reg, ...esc]);
}

async function getErc8004Events(fromBlock, toBlock) {
  const [ident, rep] = await Promise.all([
    mantleClient.getLogs({ address: IDENTITY_REGISTRY, events: [evAgentRegistered], fromBlock, toBlock }),
    mantleClient.getLogs({ address: REPUTATION_REGISTRY, events: [evNewFeedback], fromBlock, toBlock }),
  ]);
  return sortLogs([...ident, ...rep]);
}

function sortLogs(logs) {
  return logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? Number(a.logIndex - b.logIndex)
      : Number(a.blockNumber - b.blockNumber),
  );
}

/* Each watched chain is a "source": its own client, cursor, and fetcher. */
const SOURCES = [
  { name: 'Ethereum Sepolia · Mesh', client: ethClient, fetch: getMeshEvents, span: 5000n, last: 0n },
  { name: 'Mantle Sepolia · ERC-8004', client: mantleClient, fetch: getErc8004Events, span: 9000n, last: 0n },
];

async function showHistory(source, latest) {
  const fromBlock = latest > source.span ? latest - source.span : 0n;
  let all = [];
  try {
    all = await source.fetch(fromBlock, latest);
  } catch {
    console.log(paint(`  (${source.name}: could not load history from this RPC — live watch still works)`, C.dim));
    return;
  }
  const recent = all.slice(-HISTORY);
  if (recent.length === 0) {
    console.log(paint(`  ${source.name}: no activity in the last ${source.span} blocks.`, C.dim));
  } else {
    console.log(paint(`  ${source.name} — recent (last ${recent.length}):`, C.gray, C.bold));
    for (const log of recent) await render(log, false);
  }
}

/** One-time read of the agent's ERC-8004 identity so it's visible at startup. */
async function showAgentIdentity() {
  try {
    const [owner, uri] = await Promise.all([
      mantleClient.readContract({ address: IDENTITY_REGISTRY, abi: identityReadAbi, functionName: 'ownerOf', args: [COACH_AGENT_ID] }),
      mantleClient.readContract({ address: IDENTITY_REGISTRY, abi: identityReadAbi, functionName: 'tokenURI', args: [COACH_AGENT_ID] }),
    ]);
    const name = decodeAgentName(uri) || 'Kajota Coach Agent';
    console.log(paint('  🆔  ERC-8004 agent identity (Mantle)', C.bold, C.purple));
    console.log(`     ${paint('agentId', C.gray)}    ${paint(`#${COACH_AGENT_ID}`, C.bold, C.white)}  ${paint(name, C.white)}`);
    console.log(`     ${paint('owner', C.gray)}      ${paint(getAddress(owner), C.white)}`);
    console.log(`     ${paint('explorer', C.gray)}   ${paint(`${MANTLE_EXPLORER}/token/${IDENTITY_REGISTRY}?a=${COACH_AGENT_ID}`, C.blue)}`);
    console.log('');
  } catch {
    console.log(paint('  (could not read agent identity from Mantle RPC — live watch still works)', C.dim));
    console.log('');
  }
}

/* ------------------------------ main ------------------------------- */

async function main() {
  console.clear();
  banner();

  await showAgentIdentity();

  // Prime each source's cursor + show its recent history.
  for (const source of SOURCES) {
    let latest;
    try {
      latest = await source.client.getBlockNumber();
    } catch (e) {
      console.log(paint(`  ${source.name}: RPC unreachable (${e.shortMessage || e.message}) — skipping.`, C.red));
      source.last = null;
      continue;
    }
    await showHistory(source, latest);
    source.last = latest;
  }
  console.log('');
  console.log(paint('  ' + '─'.repeat(56), C.gray));

  console.log(paint(`\n  👀 Watching both chains for new on-chain activity… `, C.bold, C.green) +
    paint(`(poll ${POLL_MS}ms · ⌃C to stop)`, C.gray));
  console.log(paint('     Publish a listing (Ethereum) or "Benchmark this run" (Mantle) in the app — it shows up here in seconds.', C.dim));

  process.on('SIGINT', () => {
    console.log(paint('\n\n  Stopped. The chain keeps the receipts. 👋\n', C.gray));
    process.exit(0);
  });

  // Heartbeat so the panel visibly "breathes" on camera between events.
  let beats = 0;
  for (;;) {
    await sleep(POLL_MS);
    for (const source of SOURCES) {
      if (source.last === null) continue;
      let tip;
      try {
        tip = await source.client.getBlockNumber();
      } catch {
        continue; // transient RPC hiccup; try next tick
      }
      if (tip > source.last) {
        let logs = [];
        try {
          logs = await source.fetch(source.last + 1n, tip);
        } catch {
          // range fetch failed — skip ahead, don't get stuck
        }
        for (const log of logs) await render(log, true);
        source.last = tip;
      }
    }
    beats = (beats + 1) % 4;
    const eth = SOURCES[0].last ?? '—';
    const mnt = SOURCES[1].last ?? '—';
    process.stdout.write(
      paint(`\r  ◷ eth ${eth} · mantle ${mnt}  watching${'.'.repeat(beats)}${' '.repeat(3 - beats)}   `, C.gray),
    );
  }
}

main().catch((e) => {
  console.error(paint(`fatal: ${e.shortMessage || e.message}`, C.red));
  process.exit(1);
});
