// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title KajotaEscrow
 * @notice Buyer-to-merchant USDC escrow added to KaJota's existing
 *         order flow. The buyer locks USDC against a single
 *         delivery deadline; release happens on buyer confirmation
 *         OR on dispute-resolver verdict; refund happens on
 *         timeout OR on dispute-refund verdict.
 *
 * Flow (happy path):
 *   1. Buyer calls `createAndDeposit(merchant, amount, window)`. Contract
 *      pulls `amount` of USDC from the buyer (after the buyer's prior
 *      `approve`), records an Escrow row, returns a unique escrowId.
 *   2. Off-chain: KaJota merchant fulfills the order. Buyer's mobile
 *      app shows a "confirm delivery" CTA.
 *   3. Buyer calls `confirmDelivery(escrowId)` → contract releases
 *      the locked USDC to the merchant atomically.
 *
 * Flow (buyer protection):
 *   - `refundOnTimeout(escrowId)` — once `deliveryDeadline` has
 *     elapsed without a confirmation, the buyer self-refunds.
 *     Prevents indefinite lock-up if the merchant ghosts.
 *
 * Flow (dispute):
 *   - `raiseDispute(escrowId)` — either party can flip the row to
 *     Disputed (no funds move). The deadline-based refund is
 *     paused while disputed.
 *   - `resolveDispute(escrowId, releaseToMerchant)` — only callable
 *     by `disputeResolver`. In production this is a Chainlink
 *     Functions consumer that has just verified the off-chain
 *     adjudication; for the v0 hack demo it's a privileged multisig.
 *
 * Reentrancy: protected via OZ ReentrancyGuard.
 * USDC quirks: handled via OZ SafeERC20 (USDC's return-value
 * semantics differ from a vanilla ERC20).
 *
 * @dev Hackathon target: ETHGlobal NY 2026 (Jun 12-14). Sponsor
 *      stack: Arc (settlement chain) + LI.FI (cross-chain pay-in)
 *      + Chainlink (price feeds for local-fiat display +
 *      Functions for off-chain delivery proof in the dispute flow).
 */
contract KajotaEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        Pending,         // funds locked, awaiting confirmation / timeout / dispute
        Released,        // buyer confirmed; merchant received funds
        Refunded,        // buyer self-refunded after timeout
        Disputed,        // either party raised; awaiting resolver
        ResolvedRelease, // resolver verdict: release to merchant
        ResolvedRefund   // resolver verdict: refund to buyer
    }

    struct Escrow {
        address buyer;
        address merchant;
        uint256 amount;
        uint64 createdAt;
        uint64 deliveryDeadline; // unix seconds; after this, buyer can refundOnTimeout
        State state;
    }

    /// @notice USDC token contract (set at construction, immutable).
    /// On Arc, this is the native USDC contract (USDC is Arc's gas token).
    IERC20 public immutable usdc;

    /// @notice Address authorized to resolve disputes. In production,
    /// a Chainlink Functions consumer wrapping an off-chain
    /// adjudication signal (e.g. shipment-tracking attestation);
    /// for the v0 demo, a multisig representing the KaJota ops team.
    address public disputeResolver;

    /// @notice Minimum delivery window the buyer can specify. Prevents
    /// 1-second deadlines that would let the buyer immediately
    /// `refundOnTimeout` and effectively cancel-free.
    uint64 public constant MIN_DELIVERY_WINDOW = 1 hours;

    /// @notice Maximum delivery window the buyer can specify. Caps
    /// indefinite lock-up via wildly long deadlines.
    uint64 public constant MAX_DELIVERY_WINDOW = 60 days;

    /// @notice escrowId → Escrow row.
    ///         escrowId = keccak256(buyer, merchant, amount,
    ///         block.timestamp, nonce).
    mapping(bytes32 => Escrow) private _escrows;

    /// @notice Monotonic nonce to keep escrowIds unique even when the
    /// same (buyer, merchant, amount) triplet repeats in one block.
    uint256 private _escrowNonce;

    // ----- events -----

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed buyer,
        address indexed merchant,
        uint256 amount,
        uint64 deliveryDeadline
    );

    event DeliveryConfirmed(
        bytes32 indexed escrowId,
        address indexed buyer,
        address indexed merchant,
        uint256 amount
    );

    event RefundedOnTimeout(
        bytes32 indexed escrowId,
        address indexed buyer,
        uint256 amount
    );

    event DisputeRaised(
        bytes32 indexed escrowId,
        address indexed by
    );

    event DisputeResolved(
        bytes32 indexed escrowId,
        bool releasedToMerchant,
        uint256 amount
    );

    event DisputeResolverUpdated(
        address indexed previous,
        address indexed next
    );

    // ----- errors -----

    error InvalidUsdc();
    error InvalidDisputeResolver();
    error InvalidMerchant();
    error ZeroAmount();
    error InvalidDeliveryWindow(uint64 supplied, uint64 minWindow, uint64 maxWindow);
    error EscrowNotFound(bytes32 escrowId);
    error EscrowNotPending(bytes32 escrowId);
    error EscrowNotDisputed(bytes32 escrowId);
    error NotBuyer(address caller, address expected);
    error NotBuyerOrMerchant(address caller);
    error NotDisputeResolver(address caller);
    error DeadlineNotReached(uint64 currentTime, uint64 deadline);

    // ----- constructor -----

    constructor(IERC20 _usdc, address _disputeResolver) {
        if (address(_usdc) == address(0)) revert InvalidUsdc();
        if (_disputeResolver == address(0)) revert InvalidDisputeResolver();
        usdc = _usdc;
        disputeResolver = _disputeResolver;
    }

    // ----- core -----

    /**
     * @notice Buyer creates an escrow and deposits USDC in one call.
     *
     * Caller must have first approved this contract for at least
     * `amount` of USDC.
     *
     * @param merchant         Recipient on a successful release.
     * @param amount           USDC (6-decimal) the buyer is locking.
     * @param deliveryWindow   Seconds from now until refundOnTimeout
     *                         becomes callable. Must be in
     *                         [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW].
     * @return escrowId        Reference for later confirm / refund / dispute.
     */
    function createAndDeposit(
        address merchant,
        uint256 amount,
        uint64 deliveryWindow
    ) external nonReentrant returns (bytes32 escrowId) {
        if (merchant == address(0)) revert InvalidMerchant();
        if (amount == 0) revert ZeroAmount();
        if (deliveryWindow < MIN_DELIVERY_WINDOW || deliveryWindow > MAX_DELIVERY_WINDOW) {
            revert InvalidDeliveryWindow(deliveryWindow, MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW);
        }

        unchecked {
            _escrowNonce++;
        }
        uint64 deadline = uint64(block.timestamp) + deliveryWindow;
        escrowId = keccak256(
            abi.encodePacked(
                msg.sender,
                merchant,
                amount,
                block.timestamp,
                _escrowNonce
            )
        );

        _escrows[escrowId] = Escrow({
            buyer: msg.sender,
            merchant: merchant,
            amount: amount,
            createdAt: uint64(block.timestamp),
            deliveryDeadline: deadline,
            state: State.Pending
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit EscrowCreated(escrowId, msg.sender, merchant, amount, deadline);
    }

    /**
     * @notice Buyer confirms the order arrived. Pushes the locked
     *         USDC to the merchant atomically.
     */
    function confirmDelivery(bytes32 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        if (e.createdAt == 0) revert EscrowNotFound(escrowId);
        if (e.state != State.Pending) revert EscrowNotPending(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer(msg.sender, e.buyer);

        e.state = State.Released;
        uint256 amount = e.amount;
        address merchant = e.merchant;
        address buyer = e.buyer;

        usdc.safeTransfer(merchant, amount);
        emit DeliveryConfirmed(escrowId, buyer, merchant, amount);
    }

    /**
     * @notice Buyer self-refunds after `deliveryDeadline` has
     *         elapsed without a confirmation or active dispute.
     */
    function refundOnTimeout(bytes32 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        if (e.createdAt == 0) revert EscrowNotFound(escrowId);
        if (e.state != State.Pending) revert EscrowNotPending(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer(msg.sender, e.buyer);
        if (block.timestamp < e.deliveryDeadline) {
            revert DeadlineNotReached(uint64(block.timestamp), e.deliveryDeadline);
        }

        e.state = State.Refunded;
        uint256 amount = e.amount;
        address buyer = e.buyer;

        usdc.safeTransfer(buyer, amount);
        emit RefundedOnTimeout(escrowId, buyer, amount);
    }

    /**
     * @notice Either party flips the escrow into Disputed state.
     *         No funds move; the deadline-based refund is paused
     *         until the resolver weighs in.
     */
    function raiseDispute(bytes32 escrowId) external {
        Escrow storage e = _escrows[escrowId];
        if (e.createdAt == 0) revert EscrowNotFound(escrowId);
        if (e.state != State.Pending) revert EscrowNotPending(escrowId);
        if (msg.sender != e.buyer && msg.sender != e.merchant) {
            revert NotBuyerOrMerchant(msg.sender);
        }

        e.state = State.Disputed;
        emit DisputeRaised(escrowId, msg.sender);
    }

    /**
     * @notice Resolver settles a disputed escrow. `releaseToMerchant`
     *         true → merchant gets the funds; false → buyer is refunded.
     *
     * @dev Only callable by `disputeResolver`. In production this is a
     *      Chainlink Functions consumer that has just verified the
     *      off-chain adjudication signal.
     */
    function resolveDispute(bytes32 escrowId, bool releaseToMerchant)
        external
        nonReentrant
    {
        if (msg.sender != disputeResolver) revert NotDisputeResolver(msg.sender);

        Escrow storage e = _escrows[escrowId];
        if (e.createdAt == 0) revert EscrowNotFound(escrowId);
        if (e.state != State.Disputed) revert EscrowNotDisputed(escrowId);

        uint256 amount = e.amount;
        address recipient = releaseToMerchant ? e.merchant : e.buyer;
        e.state = releaseToMerchant ? State.ResolvedRelease : State.ResolvedRefund;

        usdc.safeTransfer(recipient, amount);
        emit DisputeResolved(escrowId, releaseToMerchant, amount);
    }

    // ----- admin -----

    /**
     * @notice Rotate the dispute resolver. Only the current resolver
     *         can call — a compromised key can't lock the system out
     *         (it always belongs to the current holder), but a
     *         working key can hand off to a successor multisig.
     */
    function setDisputeResolver(address next) external {
        if (msg.sender != disputeResolver) revert NotDisputeResolver(msg.sender);
        if (next == address(0)) revert InvalidDisputeResolver();
        address prev = disputeResolver;
        disputeResolver = next;
        emit DisputeResolverUpdated(prev, next);
    }

    // ----- view -----

    function getEscrow(bytes32 escrowId)
        external
        view
        returns (Escrow memory)
    {
        Escrow memory e = _escrows[escrowId];
        if (e.createdAt == 0) revert EscrowNotFound(escrowId);
        return e;
    }
}
