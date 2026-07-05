// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReceivableRegistry
 * @notice On-chain mirror of Kajota SME trade-finance receivables.
 *
 * A "receivable" is an unpaid invoice an SME (the `supplier`) holds
 * against a buyer (the `debtor`). The supplier wants working capital
 * now instead of waiting until `dueDate`, so a `financier` advances
 * cash against the invoice and collects the full face value when the
 * debtor pays.
 *
 * Today a Kajota invoice lives in Mongo as an order/invoice document.
 * Mesh tokenizes the trust-critical subset on-chain so:
 *   1. The receivable is a verifiable, uniquely-identified asset a
 *      financier can underwrite before committing funds.
 *   2. Its financing lifecycle (registered → financed → repaid /
 *      defaulted) is auditable by anyone, not buried in a backend.
 *   3. Kajota agents (Coach v2, Concierge) can read a supplier's
 *      on-chain receivable + repayment history to inform credit
 *      scoring — see the companion ScoreAttestation anchor.
 *
 * This contract is REGISTRATION + STATUS MIRROR only — it stores the
 * terms and tracks lifecycle state. The actual USDC advance and
 * repayment settle in `CosellEscrow` (letter-of-credit engine); an
 * authorized `controller` (the escrow/ops service) advances the
 * mirror here as funds move.
 *
 * Receivables are immutable after `register()` except for the
 * lifecycle-status transitions below. To change terms, the supplier
 * cancels a still-`Registered` receivable and registers a new one.
 *
 * @dev Hackathon target: Ignyte x Polygon Smart Commerce Challenge
 *      (SME Trade Finance track). Sister contracts: CosellRegistry,
 *      CosellEscrow, CosellShipmentVerifier.
 */
contract ReceivableRegistry {
    /// @notice Lifecycle of a receivable.
    ///  Registered — tokenized, awaiting a financier.
    ///  Financed   — a financier has advanced funds (escrow funded).
    ///  Repaid     — the debtor paid; financier made whole.
    ///  Defaulted  — past due and unpaid; marked after `dueDate`.
    ///  Cancelled  — supplier withdrew before any financing.
    enum Status {
        Registered,
        Financed,
        Repaid,
        Defaulted,
        Cancelled
    }

    struct Receivable {
        /// Stable Kajota invoice reference (Mongo ObjectId hex). The
        /// off-chain store-of-record. Indexed for lookups.
        string invoiceId;
        /// SME that raised the invoice — registers its own receivables
        /// and receives the advance. Must equal msg.sender on register.
        address supplier;
        /// Buyer that owes payment on the invoice.
        address debtor;
        /// Financier that advanced funds. address(0) until financed.
        address financier;
        /// Invoice face value in USDC base units (6-decimal). What the
        /// debtor owes and the financier ultimately collects.
        uint256 faceValue;
        /// Amount advanced to the supplier at financing, in USDC base
        /// units. 0 until financed. faceValue - advanceAmount is the
        /// financier's return (the discount).
        uint256 advanceAmount;
        /// ISO currency code of the underlying invoice (NGN, USD, ...).
        /// Kept for display/audit; settlement itself is in USDC.
        string currency;
        /// When the invoice falls due (block.timestamp seconds).
        uint64 dueDate;
        /// When the receivable was registered on-chain.
        uint64 registeredAt;
        /// When a financier funded it. 0 until financed.
        uint64 financedAt;
        /// When it was repaid. 0 until repaid.
        uint64 repaidAt;
        /// Current lifecycle status.
        Status status;
    }

    /// @notice receivableId → Receivable. id = hash(invoiceId, supplier, debtor).
    mapping(bytes32 => Receivable) private _receivables;

    /// @notice All receivableIds for a given invoiceId.
    mapping(string => bytes32[]) private _receivablesByInvoice;

    /// @notice All receivableIds where a given address is the supplier.
    /// Lets a supplier (and its credit scorer) fetch full history in one read.
    mapping(address => bytes32[]) private _receivablesBySupplier;

    /// @notice All receivableIds a given financier has funded.
    mapping(address => bytes32[]) private _receivablesByFinancier;

    /// @notice Owner — rotates the controller and ownership.
    address public owner;

    /// @notice Controller — the authority allowed to advance lifecycle
    /// status (markFinanced/markRepaid/markDefaulted). In production
    /// this is the escrow/ops service that observes fund movements.
    address public controller;

    // ----- events -----

    event ReceivableRegistered(
        bytes32 indexed receivableId,
        string indexed invoiceId,
        address indexed supplier,
        address debtor,
        uint256 faceValue,
        uint64 dueDate,
        string currency
    );

    event ReceivableFinanced(
        bytes32 indexed receivableId,
        address indexed financier,
        uint256 advanceAmount
    );

    event ReceivableRepaid(bytes32 indexed receivableId, address indexed by);

    event ReceivableDefaulted(bytes32 indexed receivableId, address indexed by);

    event ReceivableCancelled(bytes32 indexed receivableId, address indexed by);

    event ControllerUpdated(address indexed previous, address indexed next);

    event OwnershipTransferred(address indexed previous, address indexed next);

    // ----- errors -----

    error InvalidSupplier();
    error InvalidDebtor();
    error InvalidFinancier();
    error ZeroFaceValue();
    error InvalidAdvanceAmount(uint256 supplied, uint256 faceValue);
    error DueDateInPast(uint64 dueDate, uint64 nowTs);
    error EmptyInvoiceId();
    error EmptyCurrency();
    error ReceivableAlreadyExists(bytes32 receivableId);
    error ReceivableNotFound(bytes32 receivableId);
    error UnexpectedStatus(Status current, Status required);
    error NotDueYet(uint64 dueDate, uint64 nowTs);
    error NotSupplier(address caller);
    error NotController(address caller);
    error NotOwner(address caller);
    error ZeroAddress();

    // ----- modifiers -----

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert NotController(msg.sender);
        _;
    }

    /**
     * @param initialController Authority that advances lifecycle status.
     *        Pass address(0) to default it to the deployer; rotate later
     *        via setController (e.g. to point at CosellEscrow/ops).
     */
    constructor(address initialController) {
        owner = msg.sender;
        controller = initialController == address(0)
            ? msg.sender
            : initialController;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ControllerUpdated(address(0), controller);
    }

    // ----- core -----

    /**
     * @notice Tokenize an unpaid invoice as an on-chain receivable.
     *
     * @param invoiceId   Kajota invoice reference (Mongo ObjectId hex).
     * @param supplier    SME raising the invoice. Must equal msg.sender —
     *                    suppliers register their own receivables.
     * @param debtor      Buyer that owes payment. Non-zero, != supplier.
     * @param faceValue   Invoice amount in USDC base units (6-decimal).
     * @param dueDate     When the invoice falls due (must be in future).
     * @param currency    ISO currency code of the invoice, e.g. "NGN".
     * @return receivableId Deterministic id =
     *                    keccak256(invoiceId, supplier, debtor).
     */
    function register(
        string calldata invoiceId,
        address supplier,
        address debtor,
        uint256 faceValue,
        uint64 dueDate,
        string calldata currency
    ) external returns (bytes32 receivableId) {
        if (supplier == address(0) || supplier != msg.sender) {
            revert InvalidSupplier();
        }
        if (debtor == address(0) || debtor == supplier) {
            revert InvalidDebtor();
        }
        if (faceValue == 0) revert ZeroFaceValue();
        if (dueDate <= block.timestamp) {
            revert DueDateInPast(dueDate, uint64(block.timestamp));
        }
        if (bytes(invoiceId).length == 0) revert EmptyInvoiceId();
        if (bytes(currency).length == 0) revert EmptyCurrency();

        receivableId = computeReceivableId(invoiceId, supplier, debtor);
        if (_receivables[receivableId].registeredAt != 0) {
            revert ReceivableAlreadyExists(receivableId);
        }

        _receivables[receivableId] = Receivable({
            invoiceId: invoiceId,
            supplier: supplier,
            debtor: debtor,
            financier: address(0),
            faceValue: faceValue,
            advanceAmount: 0,
            currency: currency,
            dueDate: dueDate,
            registeredAt: uint64(block.timestamp),
            financedAt: 0,
            repaidAt: 0,
            status: Status.Registered
        });
        _receivablesByInvoice[invoiceId].push(receivableId);
        _receivablesBySupplier[supplier].push(receivableId);

        emit ReceivableRegistered(
            receivableId,
            invoiceId,
            supplier,
            debtor,
            faceValue,
            dueDate,
            currency
        );
    }

    /**
     * @notice Mark a receivable financed once a financier has advanced
     *         funds (escrow funded). Controller-only — the escrow/ops
     *         service calls this as it observes the on-chain advance.
     *
     * @param receivableId  The receivable being financed.
     * @param financier     Address that advanced the funds. Non-zero,
     *                      and not the supplier (can't self-finance).
     * @param advanceAmount Amount advanced to the supplier, USDC base
     *                      units. In (0, faceValue] — the difference is
     *                      the financier's discount/return.
     */
    function markFinanced(
        bytes32 receivableId,
        address financier,
        uint256 advanceAmount
    ) external onlyController {
        Receivable storage r = _load(receivableId);
        if (r.status != Status.Registered) {
            revert UnexpectedStatus(r.status, Status.Registered);
        }
        if (financier == address(0) || financier == r.supplier) {
            revert InvalidFinancier();
        }
        if (advanceAmount == 0 || advanceAmount > r.faceValue) {
            revert InvalidAdvanceAmount(advanceAmount, r.faceValue);
        }

        r.financier = financier;
        r.advanceAmount = advanceAmount;
        r.financedAt = uint64(block.timestamp);
        r.status = Status.Financed;
        _receivablesByFinancier[financier].push(receivableId);

        emit ReceivableFinanced(receivableId, financier, advanceAmount);
    }

    /**
     * @notice Mark a financed receivable repaid (debtor paid; the
     *         financier has been made whole via escrow release).
     *         Controller-only.
     */
    function markRepaid(bytes32 receivableId) external onlyController {
        Receivable storage r = _load(receivableId);
        if (r.status != Status.Financed) {
            revert UnexpectedStatus(r.status, Status.Financed);
        }
        r.repaidAt = uint64(block.timestamp);
        r.status = Status.Repaid;
        emit ReceivableRepaid(receivableId, msg.sender);
    }

    /**
     * @notice Mark a financed receivable defaulted — past `dueDate` and
     *         unpaid. Controller-only, and only callable after the due
     *         date so a live invoice can't be prematurely written off.
     */
    function markDefaulted(bytes32 receivableId) external onlyController {
        Receivable storage r = _load(receivableId);
        if (r.status != Status.Financed) {
            revert UnexpectedStatus(r.status, Status.Financed);
        }
        if (block.timestamp <= r.dueDate) {
            revert NotDueYet(r.dueDate, uint64(block.timestamp));
        }
        r.status = Status.Defaulted;
        emit ReceivableDefaulted(receivableId, msg.sender);
    }

    /**
     * @notice Cancel a still-unfinanced receivable. Only the supplier,
     *         and only while `Registered` — once a financier is on the
     *         hook the lifecycle is controller-driven.
     * @dev Does NOT delete the record — keeps on-chain history so a
     *      supplier's credit profile stays auditable.
     */
    function cancel(bytes32 receivableId) external {
        Receivable storage r = _load(receivableId);
        if (msg.sender != r.supplier) revert NotSupplier(msg.sender);
        if (r.status != Status.Registered) {
            revert UnexpectedStatus(r.status, Status.Registered);
        }
        r.status = Status.Cancelled;
        emit ReceivableCancelled(receivableId, msg.sender);
    }

    // ----- admin -----

    /// @notice Rotate the lifecycle controller. Owner-only.
    function setController(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit ControllerUpdated(controller, next);
        controller = next;
    }

    /// @notice Transfer ownership. Owner-only.
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    // ----- view -----

    function getReceivable(bytes32 receivableId)
        external
        view
        returns (Receivable memory)
    {
        Receivable memory r = _receivables[receivableId];
        if (r.registeredAt == 0) revert ReceivableNotFound(receivableId);
        return r;
    }

    function receivablesForInvoice(string calldata invoiceId)
        external
        view
        returns (bytes32[] memory)
    {
        return _receivablesByInvoice[invoiceId];
    }

    function receivablesForSupplier(address supplier)
        external
        view
        returns (bytes32[] memory)
    {
        return _receivablesBySupplier[supplier];
    }

    function receivablesForFinancier(address financier)
        external
        view
        returns (bytes32[] memory)
    {
        return _receivablesByFinancier[financier];
    }

    /**
     * @notice Compute the deterministic receivableId for a given triple.
     * @dev Exposed so the off-chain backend can compute the same id
     *      before submitting a tx — supports idempotent mints from the
     *      Coach Agent's financing tools.
     */
    function computeReceivableId(
        string calldata invoiceId,
        address supplier,
        address debtor
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(invoiceId, supplier, debtor));
    }

    /**
     * @notice Preview a financing offer's economics without moving funds.
     * @dev Pure helper: given a face value and a proposed advance,
     *      returns the financier's return (the discount). The advance
     *      must be in (0, faceValue]. Off-chain UIs use this to show
     *      "advance ₦4,500 now, collect ₦5,000 at maturity → ₦500 fee".
     * @return financierReturn faceValue - advanceAmount.
     */
    function previewFinancing(uint256 faceValue, uint256 advanceAmount)
        external
        pure
        returns (uint256 financierReturn)
    {
        if (faceValue == 0) revert ZeroFaceValue();
        if (advanceAmount == 0 || advanceAmount > faceValue) {
            revert InvalidAdvanceAmount(advanceAmount, faceValue);
        }
        financierReturn = faceValue - advanceAmount;
    }

    // ----- internal -----

    function _load(bytes32 receivableId)
        private
        view
        returns (Receivable storage r)
    {
        r = _receivables[receivableId];
        if (r.registeredAt == 0) revert ReceivableNotFound(receivableId);
    }
}
