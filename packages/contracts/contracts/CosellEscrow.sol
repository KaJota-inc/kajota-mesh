// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CosellRegistry} from "./CosellRegistry.sol";

/**
 * @title CosellEscrow
 * @notice USDC escrow for Kajota co-sell sales. Auto-splits funds
 *         between wholesaler and co-seller on release, using the
 *         commission terms locked in {CosellRegistry}.
 *
 * Flow:
 *   1. Buyer pays USDC into this contract via `deposit(listingId)`.
 *      Contract creates an `Escrowed` record and emits Deposited.
 *      A unique `depositId` is returned so the buyer / Kajota
 *      backend can reference it later.
 *   2. Off-chain: Kajota delivers the product. The shipment-confirmed
 *      event is attested to on-chain via a Chainlink Functions
 *      callback (or, for the v0 demo, via a privileged `releaseAuth`
 *      address — a multisig in prod).
 *   3. `release(depositId)` reads the listing's commissionBps, splits
 *      the held USDC, and pushes the two transfers atomically.
 *
 * Buyer-protection:
 *   - `refund(depositId)` returns the full amount to the buyer if
 *     the wholesaler hasn't released within `REFUND_DELAY`
 *     (default 14 days). Prevents indefinite lock-up if the
 *     wholesaler ghosts.
 *
 * Reentrancy: protected via OZ ReentrancyGuard.
 * USDC quirks: handled via OZ SafeERC20 (USDC's return-value
 * semantics differ from a vanilla ERC20).
 *
 * @dev Hackathon target: Mantle Turing Test Phase 2 (Jun 15) +
 *      AWS Activate Web3. Sister contract: {CosellRegistry}.
 */
contract CosellEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { Pending, Released, Refunded }

    struct Escrowed {
        bytes32 listingId;
        address buyer;
        uint256 grossAmount;
        uint64 depositedAt;
        State state;
    }

    /// @notice USDC token contract (set at construction, immutable).
    IERC20 public immutable usdc;

    /// @notice Registry of co-sell agreements — the source of truth
    /// for who-pays-whom-what-percent.
    CosellRegistry public immutable registry;

    /// @notice Address authorized to call `release()`. In production,
    /// a Chainlink Functions consumer wrapping a Kajota
    /// shipment-confirmed callback; for the v0 demo, a multisig
    /// representing the Kajota ops team.
    address public releaseAuth;

    /// @notice After this many seconds without release, the buyer
    /// can self-refund. Default 14 days.
    uint64 public constant REFUND_DELAY = 14 days;

    /// @notice depositId → Escrowed record. depositId =
    /// keccak256(listingId, buyer, grossAmount, block.timestamp, nonce)
    mapping(bytes32 => Escrowed) private _deposits;

    /// @notice Monotonic nonce to keep depositIds unique even when
    /// the same buyer deposits the same listing+amount in one block.
    uint256 private _depositNonce;

    // ----- events -----

    event Deposited(
        bytes32 indexed depositId,
        bytes32 indexed listingId,
        address indexed buyer,
        uint256 grossAmount
    );

    event Released(
        bytes32 indexed depositId,
        bytes32 indexed listingId,
        address wholesaler,
        address coseller,
        uint256 wholesalerShare,
        uint256 cosellerShare
    );

    event Refunded(
        bytes32 indexed depositId,
        address indexed buyer,
        uint256 grossAmount
    );

    event ReleaseAuthUpdated(address indexed previous, address indexed next);

    // ----- errors -----

    error InvalidUsdc();
    error InvalidRegistry();
    error InvalidReleaseAuth();
    error ZeroAmount();
    error ListingNotActive(bytes32 listingId);
    error DepositNotFound(bytes32 depositId);
    error DepositNotPending(bytes32 depositId);
    error NotReleaseAuth(address caller);
    error NotBuyer(address caller, address expected);
    error RefundTooEarly(uint64 depositedAt, uint64 refundUnlockAt);

    // ----- constructor -----

    constructor(
        IERC20 _usdc,
        CosellRegistry _registry,
        address _releaseAuth
    ) {
        if (address(_usdc) == address(0)) revert InvalidUsdc();
        if (address(_registry) == address(0)) revert InvalidRegistry();
        if (_releaseAuth == address(0)) revert InvalidReleaseAuth();
        usdc = _usdc;
        registry = _registry;
        releaseAuth = _releaseAuth;
    }

    // ----- core -----

    /**
     * @notice Buyer deposits USDC against an existing active listing.
     *
     * Caller must have first approved this contract for at least
     * `grossAmount` of USDC.
     *
     * @param listingId    Listing returned by CosellRegistry.register.
     * @param grossAmount  Total USDC (6-decimal) the buyer is paying.
     * @return depositId   Reference for later release / refund.
     */
    function deposit(bytes32 listingId, uint256 grossAmount)
        external
        nonReentrant
        returns (bytes32 depositId)
    {
        if (grossAmount == 0) revert ZeroAmount();

        // The registry call will revert with ListingNotFound if the
        // listingId is bogus — we just check active here.
        CosellRegistry.Listing memory l = registry.getListing(listingId);
        if (!l.active) revert ListingNotActive(listingId);

        unchecked {
            _depositNonce++;
        }
        depositId = keccak256(
            abi.encodePacked(
                listingId,
                msg.sender,
                grossAmount,
                block.timestamp,
                _depositNonce
            )
        );

        _deposits[depositId] = Escrowed({
            listingId: listingId,
            buyer: msg.sender,
            grossAmount: grossAmount,
            depositedAt: uint64(block.timestamp),
            state: State.Pending
        });

        usdc.safeTransferFrom(msg.sender, address(this), grossAmount);

        emit Deposited(depositId, listingId, msg.sender, grossAmount);
    }

    /**
     * @notice Release a deposit's funds — splits gross by the
     *         listing's commissionBps between wholesaler and coseller.
     *
     * @dev Only callable by `releaseAuth`. In production this is a
     *      Chainlink Functions consumer that has just verified the
     *      shipment via Kajota's signed attestation endpoint.
     */
    function release(bytes32 depositId) external nonReentrant {
        if (msg.sender != releaseAuth) revert NotReleaseAuth(msg.sender);

        Escrowed storage d = _deposits[depositId];
        if (d.depositedAt == 0) revert DepositNotFound(depositId);
        if (d.state != State.Pending) revert DepositNotPending(depositId);

        CosellRegistry.Listing memory l = registry.getListing(d.listingId);
        (uint256 cosellerShare, uint256 wholesalerShare) =
            registry.computeSplit(d.grossAmount, d.listingId);

        d.state = State.Released;

        // Atomic order: pay wholesaler first (the larger share), then
        // coseller. SafeERC20 reverts the whole tx on either failure.
        usdc.safeTransfer(l.wholesaler, wholesalerShare);
        usdc.safeTransfer(l.coseller, cosellerShare);

        emit Released(
            depositId,
            d.listingId,
            l.wholesaler,
            l.coseller,
            wholesalerShare,
            cosellerShare
        );
    }

    /**
     * @notice Buyer self-refund after REFUND_DELAY has elapsed
     *         without a release. Protects against indefinite lock-up.
     */
    function refund(bytes32 depositId) external nonReentrant {
        Escrowed storage d = _deposits[depositId];
        if (d.depositedAt == 0) revert DepositNotFound(depositId);
        if (d.state != State.Pending) revert DepositNotPending(depositId);
        if (msg.sender != d.buyer) revert NotBuyer(msg.sender, d.buyer);

        uint64 unlockAt = d.depositedAt + REFUND_DELAY;
        if (block.timestamp < unlockAt) {
            revert RefundTooEarly(d.depositedAt, unlockAt);
        }

        d.state = State.Refunded;
        uint256 amount = d.grossAmount;

        usdc.safeTransfer(d.buyer, amount);
        emit Refunded(depositId, d.buyer, amount);
    }

    // ----- admin -----

    /**
     * @notice Update the release-auth address.
     * @dev Only the *current* releaseAuth can rotate it (so a
     *      compromised key can't lock the system out, but a
     *      working one can hand off to a successor multisig).
     */
    function setReleaseAuth(address next) external {
        if (msg.sender != releaseAuth) revert NotReleaseAuth(msg.sender);
        if (next == address(0)) revert InvalidReleaseAuth();
        address prev = releaseAuth;
        releaseAuth = next;
        emit ReleaseAuthUpdated(prev, next);
    }

    // ----- view -----

    function getDeposit(bytes32 depositId)
        external
        view
        returns (Escrowed memory)
    {
        Escrowed memory d = _deposits[depositId];
        if (d.depositedAt == 0) revert DepositNotFound(depositId);
        return d;
    }
}
