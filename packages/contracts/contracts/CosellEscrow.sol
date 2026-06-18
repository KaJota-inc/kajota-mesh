// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {CosellRegistry} from "./CosellRegistry.sol";

/**
 * @title CosellEscrow
 * @notice USDC escrow for Kajota co-sell sales. Auto-splits funds
 *         between wholesaler and co-seller on release, using the
 *         commission terms locked in {CosellRegistry}.
 *
 * Settlement is enforced by the BUYER, not by Kajota's bookkeeping:
 *
 *   1. Buyer pays USDC in via `deposit(listingId)`.
 *   2a. Happy path — `confirmReceipt(depositId)`: the buyer signs to
 *       release the split. This is the trustless path: the funds move
 *       because the *buyer* confirmed receipt, not because a server
 *       said "shipped".
 *   2b. Buyer goes quiet — `release(depositId)`: the operator
 *       (`releaseAuth`, a Chainlink Functions consumer / multisig)
 *       may release, but ONLY after `RELEASE_GRACE` has elapsed and
 *       ONLY while the deposit is still `Pending`. The grace window
 *       guarantees the buyer time to confirm or dispute first, so a
 *       compromised operator key can't instant-drain fresh deposits.
 *   2c. Buyer disputes — `dispute(depositId)`: moves the deposit to
 *       `Disputed`, which freezes the operator `release` path. An
 *       independent `arbiter` then `resolveDispute(...)` to the seller
 *       (split) or the buyer (refund). This is on-chain dispute
 *       arbitration.
 *   3. Buyer self-refund — `refund(depositId)`: after `REFUND_DELAY`
 *      with no release, the buyer recovers the full amount (works from
 *      both `Pending` and `Disputed`, so an un-resolved dispute can
 *      never lock funds forever).
 *
 * Operator-key hardening:
 *   - role separation: `owner` (rotation + circuit-breaker), distinct
 *     from `releaseAuth` (operator) and `arbiter` (disputes). The
 *     operator key no longer rotates itself — a compromised operator
 *     can't entrench itself or swap in the arbiter.
 *   - `RELEASE_GRACE` rate-limits the operator path.
 *   - `pause()` lets `owner` freeze new deposits + the operator
 *     release path during an incident, while leaving the buyer's
 *     confirm / dispute / refund and the arbiter's resolution live.
 *
 * Reentrancy: OZ ReentrancyGuard. USDC quirks: OZ SafeERC20.
 *
 * @dev Hackathon target: Mantle Turing Test Phase 2. Sister contract:
 *      {CosellRegistry}.
 */
contract CosellEscrow is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    enum State { Pending, Released, Refunded, Disputed }

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

    /// @notice Operator allowed to call `release()` after the grace
    /// window. A Chainlink Functions consumer / Kajota ops multisig.
    /// Rotated only by `owner` — see {setReleaseAuth}.
    address public releaseAuth;

    /// @notice Independent dispute resolver. Decides a `Disputed`
    /// deposit in favour of the seller (split) or buyer (refund).
    /// Should be a multisig / DAO distinct from `releaseAuth`.
    address public arbiter;

    /// @notice After this many seconds without release, the buyer
    /// can self-refund. Default 14 days.
    uint64 public constant REFUND_DELAY = 14 days;

    /// @notice The operator `release()` path is locked for this long
    /// after a deposit, guaranteeing the buyer a window to confirm
    /// receipt or dispute first. The buyer's own `confirmReceipt` has
    /// no such delay.
    uint64 public constant RELEASE_GRACE = 2 days;

    /// @notice depositId → Escrowed record.
    mapping(bytes32 => Escrowed) private _deposits;

    /// @notice Monotonic nonce to keep depositIds unique.
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

    /// @notice How a Released deposit was triggered, for off-chain
    /// auditing: buyer confirmation vs operator vs arbiter.
    enum ReleaseTrigger { BuyerConfirmed, Operator, Arbiter }

    event ReleaseTriggered(bytes32 indexed depositId, ReleaseTrigger trigger);

    event Disputed(bytes32 indexed depositId, address indexed buyer);

    event DisputeResolved(
        bytes32 indexed depositId,
        address indexed arbiter,
        bool releasedToSeller
    );

    event ReleaseAuthUpdated(address indexed previous, address indexed next);
    event ArbiterUpdated(address indexed previous, address indexed next);

    // ----- errors -----

    error InvalidUsdc();
    error InvalidRegistry();
    error InvalidReleaseAuth();
    error InvalidArbiter();
    error ZeroAmount();
    error ListingNotActive(bytes32 listingId);
    error DepositNotFound(bytes32 depositId);
    error DepositNotPending(bytes32 depositId);
    error DepositNotDisputed(bytes32 depositId);
    error NotReleaseAuth(address caller);
    error NotArbiter(address caller);
    error NotBuyer(address caller, address expected);
    error RefundTooEarly(uint64 depositedAt, uint64 refundUnlockAt);
    error ReleaseTooEarly(uint64 depositedAt, uint64 releaseUnlockAt);
    error NotRefundable(bytes32 depositId);

    // ----- constructor -----

    constructor(
        IERC20 _usdc,
        CosellRegistry _registry,
        address _releaseAuth,
        address _arbiter,
        address _owner
    ) Ownable(_owner) {
        if (address(_usdc) == address(0)) revert InvalidUsdc();
        if (address(_registry) == address(0)) revert InvalidRegistry();
        if (_releaseAuth == address(0)) revert InvalidReleaseAuth();
        if (_arbiter == address(0)) revert InvalidArbiter();
        usdc = _usdc;
        registry = _registry;
        releaseAuth = _releaseAuth;
        arbiter = _arbiter;
    }

    // ----- core: deposit -----

    /**
     * @notice Buyer deposits USDC against an existing active listing.
     * Caller must have approved this contract for `grossAmount` first.
     */
    function deposit(bytes32 listingId, uint256 grossAmount)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 depositId)
    {
        if (grossAmount == 0) revert ZeroAmount();

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

    // ----- core: release paths -----

    /**
     * @notice Buyer confirms receipt and releases the split. THE
     *         trustless happy path — funds move on the buyer's own
     *         signature, with no operator and no delay. Allowed from
     *         `Pending` or `Disputed` (the buyer may voluntarily
     *         resolve their own dispute in the seller's favour).
     */
    function confirmReceipt(bytes32 depositId) external nonReentrant {
        Escrowed storage d = _deposits[depositId];
        if (d.depositedAt == 0) revert DepositNotFound(depositId);
        if (d.state != State.Pending && d.state != State.Disputed) {
            revert DepositNotPending(depositId);
        }
        if (msg.sender != d.buyer) revert NotBuyer(msg.sender, d.buyer);

        _payout(depositId, d, ReleaseTrigger.BuyerConfirmed);
    }

    /**
     * @notice Operator release for the buyer-went-quiet case. Gated to
     *         `releaseAuth`, only while `Pending` (a dispute freezes
     *         this path), only after `RELEASE_GRACE`, and only while
     *         not paused.
     *
     * @dev This is the fallback, not the primary path. The grace
     *      window + dispute freeze + pause are what stop a compromised
     *      operator key from draining the book.
     */
    function release(bytes32 depositId)
        external
        nonReentrant
        whenNotPaused
    {
        if (msg.sender != releaseAuth) revert NotReleaseAuth(msg.sender);

        Escrowed storage d = _deposits[depositId];
        if (d.depositedAt == 0) revert DepositNotFound(depositId);
        if (d.state != State.Pending) revert DepositNotPending(depositId);

        uint64 unlockAt = d.depositedAt + RELEASE_GRACE;
        if (block.timestamp < unlockAt) {
            revert ReleaseTooEarly(d.depositedAt, unlockAt);
        }

        _payout(depositId, d, ReleaseTrigger.Operator);
    }

    // ----- core: dispute -----

    /**
     * @notice Buyer opens a dispute, freezing the operator `release`
     *         path until an arbiter resolves it. Only the buyer, only
     *         while `Pending`.
     */
    function dispute(bytes32 depositId) external nonReentrant {
        Escrowed storage d = _deposits[depositId];
        if (d.depositedAt == 0) revert DepositNotFound(depositId);
        if (d.state != State.Pending) revert DepositNotPending(depositId);
        if (msg.sender != d.buyer) revert NotBuyer(msg.sender, d.buyer);

        d.state = State.Disputed;
        emit Disputed(depositId, d.buyer);
    }

    /**
     * @notice Arbiter resolves a disputed deposit: either release the
     *         split to the seller, or refund the buyer in full.
     * @param releaseToSeller true → pay wholesaler+coseller; false →
     *        refund the buyer.
     */
    function resolveDispute(bytes32 depositId, bool releaseToSeller)
        external
        nonReentrant
    {
        if (msg.sender != arbiter) revert NotArbiter(msg.sender);

        Escrowed storage d = _deposits[depositId];
        if (d.depositedAt == 0) revert DepositNotFound(depositId);
        if (d.state != State.Disputed) revert DepositNotDisputed(depositId);

        emit DisputeResolved(depositId, msg.sender, releaseToSeller);
        if (releaseToSeller) {
            _payout(depositId, d, ReleaseTrigger.Arbiter);
        } else {
            _refundTo(depositId, d);
        }
    }

    // ----- core: refund -----

    /**
     * @notice Buyer self-refund after REFUND_DELAY without a release.
     *         Works from `Pending` or `Disputed`, so an un-resolved
     *         dispute can never lock the buyer's funds indefinitely.
     */
    function refund(bytes32 depositId) external nonReentrant {
        Escrowed storage d = _deposits[depositId];
        if (d.depositedAt == 0) revert DepositNotFound(depositId);
        if (d.state != State.Pending && d.state != State.Disputed) {
            revert NotRefundable(depositId);
        }
        if (msg.sender != d.buyer) revert NotBuyer(msg.sender, d.buyer);

        uint64 unlockAt = d.depositedAt + REFUND_DELAY;
        if (block.timestamp < unlockAt) {
            revert RefundTooEarly(d.depositedAt, unlockAt);
        }

        _refundTo(depositId, d);
    }

    // ----- internal: money movement (CEI — state set before transfer) -----

    function _payout(
        bytes32 depositId,
        Escrowed storage d,
        ReleaseTrigger trigger
    ) private {
        CosellRegistry.Listing memory l = registry.getListing(d.listingId);
        (uint256 cosellerShare, uint256 wholesalerShare) =
            registry.computeSplit(d.grossAmount, d.listingId);

        d.state = State.Released;

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
        emit ReleaseTriggered(depositId, trigger);
    }

    function _refundTo(bytes32 depositId, Escrowed storage d) private {
        d.state = State.Refunded;
        uint256 amount = d.grossAmount;
        usdc.safeTransfer(d.buyer, amount);
        emit Refunded(depositId, d.buyer, amount);
    }

    // ----- admin (owner-gated; operator can no longer rotate itself) -----

    /// @notice Rotate the operator address. Owner-only.
    function setReleaseAuth(address next) external onlyOwner {
        if (next == address(0)) revert InvalidReleaseAuth();
        address prev = releaseAuth;
        releaseAuth = next;
        emit ReleaseAuthUpdated(prev, next);
    }

    /// @notice Rotate the arbiter address. Owner-only.
    function setArbiter(address next) external onlyOwner {
        if (next == address(0)) revert InvalidArbiter();
        address prev = arbiter;
        arbiter = next;
        emit ArbiterUpdated(prev, next);
    }

    /// @notice Circuit breaker: freeze new deposits + the operator
    /// release path during an incident. Buyer confirm/dispute/refund
    /// and arbiter resolution stay live.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
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
