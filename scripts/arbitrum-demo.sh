#!/usr/bin/env bash
# arbitrum-demo.sh — full on-chain happy-path against the live
# CosellRegistry + CosellEscrow on Arbitrum Sepolia. Use this to
# screen-record the Arbitrum Open House London buildathon demo:
# pair the terminal output with Arbiscan tabs and voice-over the
# agentic narrative (Coach drafts → Concierge buys → Mesh settles).
#
# Reads keys from kajota-mesh/.env (gitignored):
#   DEPLOYER_PRIVATE_KEY  signs as wholesaler + releaseAuth
#   BUYER_PRIVATE_KEY     signs as buyer (must have ~1 USDC + tiny ETH)
#
# Usage:
#   cd ~/Documents/GitHub/kajota-mesh
#   ./scripts/arbitrum-demo.sh
#
# Requires: foundry (cast) + jq on PATH.

set -euo pipefail

# ---- bash 3.2-friendly colour helpers (macOS default shell) -------
BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
BLUE=$(printf '\033[34m'); CYAN=$(printf '\033[36m')

step()    { printf "\n${BOLD}${BLUE}━━━ %s ━━━${RESET}\n" "$*"; }
ok()      { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
info()    { printf "  ${DIM}%s${RESET}\n" "$*"; }
fail()    { printf "  ${RED}✗${RESET} %s\n" "$*"; exit 1; }
arbiscan(){ printf "    ${CYAN}https://sepolia.arbiscan.io/tx/%s${RESET}\n" "$1"; }

# ---- env ----------------------------------------------------------
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ENV_FILE="$SCRIPT_DIR/../.env"
[ -f "$ENV_FILE" ] || fail ".env not found at $ENV_FILE"
set -a; . "$ENV_FILE"; set +a

: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY missing from .env}"
: "${BUYER_PRIVATE_KEY:?BUYER_PRIVATE_KEY missing from .env}"

# ---- network + contracts (live on Arbitrum Sepolia) ---------------
RPC="https://sepolia-rollup.arbitrum.io/rpc"
REGISTRY="0xfce6bd68d8d6f858d447f537d206c1e354b44315"
ESCROW="0x599869cef2e4c52e2c9074caaf8f9fb0cb191776"
USDC="0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"

# ---- demo participants --------------------------------------------
WHOLESALER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
BUYER=$(cast wallet address --private-key "$BUYER_PRIVATE_KEY")
COSELLER="0x33cdCcbC1c759E21ba8d943918A13AA78dbEeb42"   # any distinct EOA

# ---- demo parameters ----------------------------------------------
PRODUCT_ID="demo-headphones-$(date +%s)"
COMMISSION_BPS=1000                                       # 10%
CURRENCY="USDC"
AMOUNT=1000000                                            # 1 USDC (6 decimals)

# ---- helpers ------------------------------------------------------
send() {
  local key=$1 to=$2 sig=$3; shift 3
  cast send --rpc-url "$RPC" --private-key "$key" --json "$to" "$sig" "$@"
}
read_call() { cast call --rpc-url "$RPC" "$@"; }
balance_usdc() {
  local addr=$1
  local raw; raw=$(read_call "$USDC" "balanceOf(address)(uint256)" "$addr")
  # cast may return "1000000 [1e6]" — strip suffix, then format
  raw="${raw%% *}"
  printf "%s.%06d" "$((raw / 1000000))" "$((raw % 1000000))"
}

# ---- title --------------------------------------------------------
clear 2>/dev/null || true
cat <<EOF
${BOLD}╔══════════════════════════════════════════════════════════════════╗
║  Kajota Mesh — Arbitrum Open House London demo                   ║
║  Coach drafts → Concierge buys → Mesh settles on Arbitrum Sepolia║
╚══════════════════════════════════════════════════════════════════╝${RESET}

  ${BOLD}Registry${RESET}   $REGISTRY
  ${BOLD}Escrow${RESET}     $ESCROW
  ${BOLD}USDC${RESET}       $USDC

  ${BOLD}Wholesaler${RESET} $WHOLESALER  ${DIM}(Coach drafts the listing)${RESET}
  ${BOLD}Coseller${RESET}   $COSELLER  ${DIM}(receives 10% commission)${RESET}
  ${BOLD}Buyer${RESET}      $BUYER  ${DIM}(Concierge runs the buy)${RESET}

  ${BOLD}Order${RESET}      productId=$PRODUCT_ID  amount=1.000000 USDC  split=10%/90%
EOF

# ---- balance preflight --------------------------------------------
step "Preflight — balances on Arbitrum Sepolia"
info "Buyer USDC:        $(balance_usdc $BUYER)"
info "Coseller USDC:     $(balance_usdc $COSELLER)"
info "Wholesaler USDC:   $(balance_usdc $WHOLESALER)"

BUYER_USDC_RAW=$(read_call "$USDC" "balanceOf(address)(uint256)" "$BUYER")
BUYER_USDC_RAW="${BUYER_USDC_RAW%% *}"
[ "$BUYER_USDC_RAW" -ge "$AMOUNT" ] || fail "Buyer needs ≥1 USDC. Get some at https://faucet.circle.com (Arbitrum Sepolia)"
ok "Buyer has ≥1 USDC — ready to deposit"

# ---- STEP 1: register listing (wholesaler) ------------------------
step "Step 1 — Coach publishes listing on-chain (CosellRegistry.register)"
RESP=$(send "$DEPLOYER_PRIVATE_KEY" "$REGISTRY" \
  "register(string,address,address,uint16,string)(bytes32)" \
  "$PRODUCT_ID" "$WHOLESALER" "$COSELLER" "$COMMISSION_BPS" "$CURRENCY")
TX1=$(echo "$RESP" | jq -r '.transactionHash')
arbiscan "$TX1"

# listingId comes back in the first log's first topic (ListingRegistered indexed bytes32 listingId)
LISTING_ID=$(echo "$RESP" | jq -r '.logs[0].topics[1]')
ok "listingId = $LISTING_ID"
info "Registry now holds wholesaler=$WHOLESALER, coseller=$COSELLER, bps=$COMMISSION_BPS"

# ---- STEP 2: approve USDC (buyer) ---------------------------------
step "Step 2 — Concierge approves USDC spend (ERC20.approve)"
RESP=$(send "$BUYER_PRIVATE_KEY" "$USDC" \
  "approve(address,uint256)" "$ESCROW" "$AMOUNT")
TX2=$(echo "$RESP" | jq -r '.transactionHash')
arbiscan "$TX2"
ok "Buyer approved $ESCROW for $AMOUNT (1.000000 USDC)"

# ---- STEP 3: deposit (buyer) --------------------------------------
step "Step 3 — Concierge deposits into escrow (CosellEscrow.deposit)"
RESP=$(send "$BUYER_PRIVATE_KEY" "$ESCROW" \
  "deposit(bytes32,uint256)" "$LISTING_ID" "$AMOUNT")
TX3=$(echo "$RESP" | jq -r '.transactionHash')
arbiscan "$TX3"
# depositId is the indexed first topic of the Deposited event (after the transfer log)
DEPOSIT_ID=$(echo "$RESP" | jq -r '[.logs[] | select(.topics[0] == "0x" + (env.DEPOSITED_SIG // ""))] | .[0].topics[1] // (.logs[-1].topics[1])' 2>/dev/null || true)
# Fallback: last log's first indexed topic (Deposited is emitted last by the contract)
[ -n "$DEPOSIT_ID" ] && [ "$DEPOSIT_ID" != "null" ] || DEPOSIT_ID=$(echo "$RESP" | jq -r '.logs[-1].topics[1]')
ok "depositId = $DEPOSIT_ID"

# ---- STEP 4: release (releaseAuth = deployer) ---------------------
step "Step 4 — Mesh settles trustlessly (CosellEscrow.release)"
RESP=$(send "$DEPLOYER_PRIVATE_KEY" "$ESCROW" \
  "release(bytes32)" "$DEPOSIT_ID")
TX4=$(echo "$RESP" | jq -r '.transactionHash')
arbiscan "$TX4"
ok "Funds auto-split: 10% → coseller, 90% → wholesaler"

# ---- VERIFY -------------------------------------------------------
step "Verify — balances changed atomically"
info "Buyer USDC:        $(balance_usdc $BUYER)"
info "Coseller USDC:     $(balance_usdc $COSELLER)  ${GREEN}← received commission${RESET}"
info "Wholesaler USDC:   $(balance_usdc $WHOLESALER)  ${GREEN}← received remainder${RESET}"

cat <<EOF

${BOLD}${GREEN}✓ Full happy path settled on Arbitrum Sepolia.${RESET}

  ${BOLD}On-chain artifacts (paste into the HackQuest submission):${RESET}
    register        $CYAN https://sepolia.arbiscan.io/tx/$TX1 $RESET
    approve         $CYAN https://sepolia.arbiscan.io/tx/$TX2 $RESET
    deposit         $CYAN https://sepolia.arbiscan.io/tx/$TX3 $RESET
    release         $CYAN https://sepolia.arbiscan.io/tx/$TX4 $RESET

  ${BOLD}Verified contracts:${RESET}
    Registry        $CYAN https://sepolia.arbiscan.io/address/$REGISTRY#code $RESET
    Escrow          $CYAN https://sepolia.arbiscan.io/address/$ESCROW#code $RESET
EOF
