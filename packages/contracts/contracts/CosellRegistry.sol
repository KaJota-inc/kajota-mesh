// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CosellRegistry
 * @notice On-chain mirror of Kajota co-sell agreements.
 *
 * A "co-sell agreement" is the contract between a wholesaler (the
 * original product seller) and a co-seller (a micro-distributor who
 * resells the product to their network for an agreed commission).
 *
 * Today this lives in Mongo as a `CosellProduct` document — fields:
 *   { productId, storeId, userId, markupPercentage, referralCode, ... }
 *
 * Mesh mirrors the trust-critical subset on-chain so:
 *   1. The commission split is enforceable by math, not by mongo +
 *      a cron job + manual payouts.
 *   2. Co-sellers can verify the terms before promoting a product.
 *   3. Future Kajota agents (Coach v2, Concierge) can read terms
 *      directly from chain rather than calling the backend.
 *
 * This contract is REGISTRATION ONLY — it stores the terms. The actual
 * USDC routing happens in `CosellEscrow` (separate contract, links to
 * a listing here by `listingId`).
 *
 * Listings are immutable after `register()` except via
 * `deactivate()`. This is intentional: changing terms mid-flight
 * would break in-flight payments and trust. To change terms, the
 * wholesaler deactivates the old listing and registers a new one.
 *
 * @dev Hackathon target: Mantle Turing Test Phase 2 (Jun 15) +
 *      AWS Activate Web3. Sister project: kajota-concierge.
 */
contract CosellRegistry {
    /// @notice Maximum commission percentage in basis points (50% cap).
    uint16 public constant MAX_COMMISSION_BPS = 5000;

    /// @notice One basis point = 0.01%. 10000 bps = 100%.
    uint16 public constant BPS_DENOMINATOR = 10000;

    struct Listing {
        /// Stable Kajota productId (Mongo ObjectId hex). The off-chain
        /// store-of-record. Indexed for buyer lookups.
        string productId;
        /// Wholesaler's wallet — receives the post-commission share.
        address wholesaler;
        /// Co-seller's wallet — receives the commission share.
        address coseller;
        /// Commission percentage in basis points (e.g. 1500 = 15%).
        uint16 commissionBps;
        /// ISO currency code (NGN, USD, GHS, KES). String so we don't
        /// need a separate currency registry on-chain.
        string currency;
        /// When the listing was registered (block.timestamp).
        uint64 registeredAt;
        /// True until the wholesaler calls `deactivate()`.
        bool active;
    }

    /// @notice listingId → Listing. listingId is hash(productId, wholesaler, coseller).
    mapping(bytes32 => Listing) private _listings;

    /// @notice All listingIds for a given productId — supports "who's
    /// re-selling this product?" queries.
    mapping(string => bytes32[]) private _listingsByProduct;

    /// @notice All listingIds where a given address is the co-seller.
    /// Lets a co-seller fetch their whole portfolio in one read.
    mapping(address => bytes32[]) private _listingsByCoseller;

    // ----- events -----

    event ListingRegistered(
        bytes32 indexed listingId,
        string indexed productId,
        address indexed wholesaler,
        address coseller,
        uint16 commissionBps,
        string currency
    );

    event ListingDeactivated(bytes32 indexed listingId, address indexed by);

    // ----- errors -----

    error InvalidWholesaler();
    error InvalidCoseller();
    error InvalidCommissionBps(uint16 supplied, uint16 max);
    error EmptyProductId();
    error EmptyCurrency();
    error ListingAlreadyExists(bytes32 listingId);
    error ListingNotFound(bytes32 listingId);
    error ListingNotActive(bytes32 listingId);
    error NotWholesaler(address caller);

    // ----- core -----

    /**
     * @notice Register a new co-sell agreement on-chain.
     *
     * @param productId       Kajota productId (Mongo ObjectId hex).
     * @param wholesaler      Address of the original product seller.
     *                        Must equal `msg.sender` — the wholesaler
     *                        registers their own listings; co-sellers
     *                        cannot register on behalf of someone else.
     * @param coseller        Address of the micro-distributor reselling.
     * @param commissionBps   Commission in basis points. Capped at
     *                        MAX_COMMISSION_BPS (50%).
     * @param currency        ISO currency code, e.g. "NGN".
     * @return listingId      Deterministic id =
     *                        keccak256(productId, wholesaler, coseller).
     */
    function register(
        string calldata productId,
        address wholesaler,
        address coseller,
        uint16 commissionBps,
        string calldata currency
    ) external returns (bytes32 listingId) {
        if (wholesaler == address(0) || wholesaler != msg.sender) {
            revert InvalidWholesaler();
        }
        if (coseller == address(0) || coseller == wholesaler) {
            revert InvalidCoseller();
        }
        if (commissionBps == 0 || commissionBps > MAX_COMMISSION_BPS) {
            revert InvalidCommissionBps(commissionBps, MAX_COMMISSION_BPS);
        }
        if (bytes(productId).length == 0) revert EmptyProductId();
        if (bytes(currency).length == 0) revert EmptyCurrency();

        listingId = computeListingId(productId, wholesaler, coseller);
        if (_listings[listingId].registeredAt != 0) {
            revert ListingAlreadyExists(listingId);
        }

        _listings[listingId] = Listing({
            productId: productId,
            wholesaler: wholesaler,
            coseller: coseller,
            commissionBps: commissionBps,
            currency: currency,
            registeredAt: uint64(block.timestamp),
            active: true
        });
        _listingsByProduct[productId].push(listingId);
        _listingsByCoseller[coseller].push(listingId);

        emit ListingRegistered(
            listingId,
            productId,
            wholesaler,
            coseller,
            commissionBps,
            currency
        );
    }

    /**
     * @notice Deactivate a listing. Only the wholesaler can call this.
     * @dev Does NOT delete the listing — keeps the on-chain history
     *      so past splits can still be audited. Just flips `active=false`.
     */
    function deactivate(bytes32 listingId) external {
        Listing storage l = _listings[listingId];
        if (l.registeredAt == 0) revert ListingNotFound(listingId);
        if (!l.active) revert ListingNotActive(listingId);
        if (msg.sender != l.wholesaler) revert NotWholesaler(msg.sender);
        l.active = false;
        emit ListingDeactivated(listingId, msg.sender);
    }

    // ----- view -----

    function getListing(bytes32 listingId)
        external
        view
        returns (Listing memory)
    {
        Listing memory l = _listings[listingId];
        if (l.registeredAt == 0) revert ListingNotFound(listingId);
        return l;
    }

    function listingsForProduct(string calldata productId)
        external
        view
        returns (bytes32[] memory)
    {
        return _listingsByProduct[productId];
    }

    function listingsForCoseller(address coseller)
        external
        view
        returns (bytes32[] memory)
    {
        return _listingsByCoseller[coseller];
    }

    /**
     * @notice Compute the deterministic listingId for a given triple.
     * @dev Exposed publicly so the off-chain backend can compute the
     *      same id before submitting a tx — useful for idempotent
     *      mints from Coach Agent's `publishListing` tool.
     */
    function computeListingId(
        string calldata productId,
        address wholesaler,
        address coseller
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(productId, wholesaler, coseller));
    }

    /**
     * @notice Apply a listing's commission split to a gross amount.
     * @dev Pure function — does not move funds. Useful for off-chain
     *      preview ("if this product sells for ₦5,000, the coseller
     *      gets ₦750 and the wholesaler gets ₦4,250"). The on-chain
     *      escrow contract uses the same math when releasing funds.
     */
    function computeSplit(uint256 grossAmount, bytes32 listingId)
        external
        view
        returns (uint256 cosellerShare, uint256 wholesalerShare)
    {
        Listing memory l = _listings[listingId];
        if (l.registeredAt == 0) revert ListingNotFound(listingId);
        cosellerShare = (grossAmount * l.commissionBps) / BPS_DENOMINATOR;
        wholesalerShare = grossAmount - cosellerShare;
    }
}
