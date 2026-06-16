#!/usr/bin/env node
/**
 * Kajota Mesh — LIVE on-chain watcher (demo companion).
 *
 * Run this in a terminal next to the mobile app while you screen-record.
 * The moment you tap "Sign on Ethereum Sepolia" in the Coach Agent flow,
 * the `register()` tx lands and this panel lights up with the decoded
 * ListingRegistered event — proving the listing is really on-chain, not
 * a mock. It also watches the escrow (Deposited / Released / Refunded)
 * so you can demo the full settlement loop in one window.
 *
 *   cd packages/contracts        # viem resolves here in this workspace
 *   node scripts/mesh-demo-watch.mjs
 *
 * Optional env:
 *   RPC_URL=...   override the Sepolia RPC (default: a public node)
 *   POLL_MS=4000  poll interval in ms
 *   HISTORY=3     how many recent listings to show on startup
 *
 * Zero config needed — the live Sepolia contract addresses are baked in.
 */
import { createPublicClient, http, parseAbiItem, formatUnits, getAddress } from 'viem';

/* ----------------------------- config ------------------------------ */

const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const POLL_MS = Number(process.env.POLL_MS || 4000);
const HISTORY = Number(process.env.HISTORY || 3);

const CHAIN_ID = 11155111;
const REGISTRY = '0xfce6bd68d8d6f858d447f537d206c1e354b44315';
const ESCROW = '0x599869cef2e4c52e2c9074caaf8f9fb0cb191776';
const EXPLORER = 'https://sepolia.etherscan.io';
const USDC_DECIMALS = 6;

/* ----------------------------- abis -------------------------------- */

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

/* --------------------------- ansi helpers -------------------------- */

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  gray: '\x1b[90m', orange: '\x1b[38;5;208m',
};
const paint = (s, ...codes) => codes.join('') + s + C.reset;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const now = () => new Date().toLocaleTimeString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- client ------------------------------ */

const client = createPublicClient({ transport: http(RPC_URL) });

/* ----------------------------- render ------------------------------ */

function banner() {
  const line = '═'.repeat(58);
  console.log(paint(`╔${line}╗`, C.orange, C.bold));
  console.log(paint('║', C.orange, C.bold) +
    paint('   🔗  KAJOTA MESH  ·  LIVE ON-CHAIN WATCHER             ', C.bold, C.white) +
    paint('║', C.orange, C.bold));
  console.log(paint(`╚${line}╝`, C.orange, C.bold));
  console.log(`${paint('Chain', C.gray)}     Ethereum Sepolia ${paint(`(${CHAIN_ID})`, C.gray)}`);
  console.log(`${paint('Registry', C.gray)}  ${paint(REGISTRY, C.cyan)}`);
  console.log(`${paint('Escrow', C.gray)}    ${paint(ESCROW, C.cyan)}`);
  console.log(`${paint('RPC', C.gray)}       ${paint(RPC_URL, C.dim)}`);
  console.log('');
}

async function enrichListing(listingId) {
  try {
    return await client.readContract({
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
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderDeactivated(log) {
  console.log('');
  console.log(paint('  🟡  LISTING DEACTIVATED ', C.bold, C.yellow) + paint(`· ${now()}`, C.gray));
  console.log(`     ${paint('listingId', C.gray)}  ${paint(log.args.listingId, C.magenta)}`);
  console.log(`     ${paint('by', C.gray)}         ${getAddress(log.args.by)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderDeposited(log) {
  console.log('');
  console.log(paint('  💰  ESCROW DEPOSIT ', C.bold, C.cyan) + paint(`· ${now()}`, C.gray));
  console.log(`     ${paint('listingId', C.gray)}  ${paint(log.args.listingId, C.magenta)}`);
  console.log(`     ${paint('buyer', C.gray)}      ${getAddress(log.args.buyer)}`);
  console.log(`     ${paint('amount', C.gray)}     ${paint(`${formatUnits(log.args.grossAmount, USDC_DECIMALS)} USDC`, C.bold, C.cyan)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderReleased(log) {
  console.log('');
  console.log(paint('  ✅  ESCROW RELEASED (auto-split) ', C.bold, C.green) + paint(`· ${now()}`, C.gray));
  console.log(`     ${paint('listingId', C.gray)}  ${paint(log.args.listingId, C.magenta)}`);
  console.log(`     ${paint('→ wholesaler', C.gray)} ${paint(`${formatUnits(log.args.wholesalerShare, USDC_DECIMALS)} USDC`, C.bold, C.white)}  ${short(getAddress(log.args.wholesaler))}`);
  console.log(`     ${paint('→ co-seller', C.gray)}  ${paint(`${formatUnits(log.args.cosellerShare, USDC_DECIMALS)} USDC`, C.bold, C.green)}  ${short(getAddress(log.args.coseller))}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

function renderRefunded(log) {
  console.log('');
  console.log(paint('  ↩️   ESCROW REFUNDED ', C.bold, C.orange) + paint(`· ${now()}`, C.gray));
  console.log(`     ${paint('buyer', C.gray)}      ${getAddress(log.args.buyer)}`);
  console.log(`     ${paint('amount', C.gray)}     ${paint(`${formatUnits(log.args.grossAmount, USDC_DECIMALS)} USDC`, C.bold, C.orange)}`);
  console.log(`     ${paint('tx', C.gray)}         ${paint(`${EXPLORER}/tx/${log.transactionHash}`, C.blue)}`);
}

async function render(log, fresh) {
  switch (log.eventName) {
    case 'ListingRegistered': return renderRegistered(log, { fresh });
    case 'ListingDeactivated': return renderDeactivated(log);
    case 'Deposited': return renderDeposited(log);
    case 'Released': return renderReleased(log);
    case 'Refunded': return renderRefunded(log);
    default: return undefined;
  }
}

/* ------------------------------ logs ------------------------------- */

async function getEvents(fromBlock, toBlock) {
  const [reg, esc] = await Promise.all([
    client.getLogs({ address: REGISTRY, events: registryEvents, fromBlock, toBlock }),
    client.getLogs({ address: ESCROW, events: escrowEvents, fromBlock, toBlock }),
  ]);
  return [...reg, ...esc].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? Number(a.logIndex - b.logIndex)
      : Number(a.blockNumber - b.blockNumber),
  );
}

async function showHistory(latest) {
  // Sepolia is ~12s/block; ~5000 blocks ≈ last ~16h of activity.
  const span = 5000n;
  const fromBlock = latest > span ? latest - span : 0n;
  let all = [];
  try {
    all = await getEvents(fromBlock, latest);
  } catch {
    console.log(paint('  (could not load history from this RPC — live watch still works)', C.dim));
  }
  const recent = all.slice(-HISTORY);
  if (recent.length === 0) {
    console.log(paint('  No recent activity in the last ~5000 blocks.', C.dim));
  } else {
    console.log(paint(`  Recent activity (last ${recent.length}):`, C.gray, C.bold));
    for (const log of recent) await render(log, false);
  }
  console.log('');
  console.log(paint('  ' + '─'.repeat(56), C.gray));
}

/* ------------------------------ main ------------------------------- */

async function main() {
  console.clear();
  banner();

  let latest;
  try {
    latest = await client.getBlockNumber();
  } catch (e) {
    console.error(paint(`Could not reach RPC ${RPC_URL}: ${e.shortMessage || e.message}`, C.red));
    process.exit(1);
  }

  await showHistory(latest);

  console.log(paint(`\n  👀 Watching for new on-chain activity… ` , C.bold, C.green) +
    paint(`(poll ${POLL_MS}ms · ⌃C to stop)`, C.gray));
  console.log(paint('     Tap "Sign on Ethereum Sepolia" in the app — it shows up here in seconds.', C.dim));

  let last = latest;
  process.on('SIGINT', () => {
    console.log(paint('\n\n  Stopped. The chain keeps the receipts. 👋\n', C.gray));
    process.exit(0);
  });

  // Heartbeat so the panel visibly "breathes" on camera between events.
  let beats = 0;
  for (;;) {
    await sleep(POLL_MS);
    let tip;
    try {
      tip = await client.getBlockNumber();
    } catch {
      process.stdout.write(paint(`\r  …rpc hiccup, retrying ${now()}        `, C.dim));
      continue;
    }
    if (tip > last) {
      let logs = [];
      try {
        logs = await getEvents(last + 1n, tip);
      } catch {
        // range fetch failed — skip ahead, don't get stuck
      }
      for (const log of logs) await render(log, true);
      last = tip;
    }
    beats = (beats + 1) % 4;
    process.stdout.write(
      paint(`\r  ◷ block ${last}  watching${'.'.repeat(beats)}${' '.repeat(3 - beats)}   `, C.gray),
    );
  }
}

main().catch((e) => {
  console.error(paint(`fatal: ${e.shortMessage || e.message}`, C.red));
  process.exit(1);
});
