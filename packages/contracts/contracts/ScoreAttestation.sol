// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ScoreAttestation
 * @notice On-chain anchor for Kajota SME trade-credit scores.
 *
 * Credit scoring runs off-chain (the Coach scoring engine reads a
 * supplier's trade history — order volume, tenure, and on-chain
 * repayment record from ReceivableRegistry — and produces a 0..1000
 * score + risk band). Publishing the raw financials on-chain would be
 * a privacy leak, so instead an authorized `attester` (the scoring
 * service wallet) anchors:
 *
 *   - scoreHash: keccak256 of the full scoring payload (inputs +
 *     result). Anyone the supplier shares the payload with can
 *     recompute the hash and verify it matches chain — tamper-evident
 *     without revealing anything on-chain.
 *   - score + band: the headline numbers a financier reads before
 *     underwriting, cheap to read on-chain.
 *
 * This makes the score a portable, verifiable credential: a financier
 * (or a future Kajota agent) trusts the number because it's signed by
 * a known attester and the supplier can prove the inputs on demand.
 *
 * Only the latest attestation per subject is kept (a credit score is a
 * current view); `attestationCount` tracks how many times a subject
 * has been scored so freshness/history depth is legible.
 *
 * @dev Hackathon target: Ignyte x Polygon Smart Commerce Challenge
 *      (SME Trade Finance track). Companion: ReceivableRegistry,
 *      CosellEscrow.
 */
contract ScoreAttestation {
    /// @notice Max numeric score (inclusive). Scores are 0..1000.
    uint16 public constant MAX_SCORE = 1000;

    /// @notice Highest valid band index (0..4 → five bands, e.g.
    /// A/B/C/D/E from strongest to weakest credit).
    uint8 public constant MAX_BAND = 4;

    struct Attestation {
        /// keccak256 of the off-chain scoring payload — the verifiable
        /// commitment. Non-zero once attested.
        bytes32 scoreHash;
        /// Numeric credit score, 0..1000.
        uint16 score;
        /// Risk band index, 0 (strongest) .. MAX_BAND (weakest).
        uint8 band;
        /// When this attestation was written (block.timestamp).
        uint64 attestedAt;
        /// The attester that wrote it.
        address attester;
    }

    /// @notice subject (SME wallet) → latest attestation.
    mapping(address => Attestation) private _latest;

    /// @notice subject → number of times scored (freshness/history depth).
    mapping(address => uint256) public attestationCount;

    /// @notice Owner — manages the attester allowlist + ownership.
    address public owner;

    /// @notice Addresses authorized to write attestations (scoring service).
    mapping(address => bool) public isAttester;

    // ----- events -----

    event ScoreAttested(
        address indexed subject,
        uint16 score,
        uint8 band,
        bytes32 scoreHash,
        address indexed attester
    );

    event AttesterUpdated(address indexed attester, bool allowed);

    event OwnershipTransferred(address indexed previous, address indexed next);

    // ----- errors -----

    error NotOwner(address caller);
    error NotAttester(address caller);
    error InvalidSubject();
    error ZeroScoreHash();
    error ScoreOutOfRange(uint16 supplied, uint16 max);
    error BandOutOfRange(uint8 supplied, uint8 max);
    error NoAttestation(address subject);
    error ZeroAddress();

    // ----- modifiers -----

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyAttester() {
        if (!isAttester[msg.sender]) revert NotAttester(msg.sender);
        _;
    }

    /**
     * @param initialAttester Address authorized to write attestations.
     *        Pass address(0) to authorize just the deployer; add more
     *        later via setAttester. The deployer is always the owner.
     */
    constructor(address initialAttester) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        address attester = initialAttester == address(0)
            ? msg.sender
            : initialAttester;
        isAttester[attester] = true;
        emit AttesterUpdated(attester, true);
    }

    // ----- core -----

    /**
     * @notice Anchor a fresh credit score for a subject. Attester-only.
     *
     * @param subject   The SME wallet being scored. Non-zero.
     * @param scoreHash keccak256 of the off-chain scoring payload.
     *                  Non-zero — this is the verifiable commitment.
     * @param score     Numeric score in 0..MAX_SCORE (1000).
     * @param band      Risk band index in 0..MAX_BAND (4).
     */
    function attest(
        address subject,
        bytes32 scoreHash,
        uint16 score,
        uint8 band
    ) external onlyAttester {
        if (subject == address(0)) revert InvalidSubject();
        if (scoreHash == bytes32(0)) revert ZeroScoreHash();
        if (score > MAX_SCORE) revert ScoreOutOfRange(score, MAX_SCORE);
        if (band > MAX_BAND) revert BandOutOfRange(band, MAX_BAND);

        _latest[subject] = Attestation({
            scoreHash: scoreHash,
            score: score,
            band: band,
            attestedAt: uint64(block.timestamp),
            attester: msg.sender
        });
        unchecked {
            attestationCount[subject] += 1;
        }

        emit ScoreAttested(subject, score, band, scoreHash, msg.sender);
    }

    // ----- admin -----

    /// @notice Add or remove an attester. Owner-only.
    function setAttester(address attester, bool allowed) external onlyOwner {
        if (attester == address(0)) revert ZeroAddress();
        isAttester[attester] = allowed;
        emit AttesterUpdated(attester, allowed);
    }

    /// @notice Transfer ownership. Owner-only.
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    // ----- view -----

    /// @notice Latest attestation for a subject. Reverts if never scored.
    function getScore(address subject)
        external
        view
        returns (Attestation memory)
    {
        Attestation memory a = _latest[subject];
        if (a.attestedAt == 0) revert NoAttestation(subject);
        return a;
    }

    /// @notice True if the subject has ever been scored.
    function hasScore(address subject) external view returns (bool) {
        return _latest[subject].attestedAt != 0;
    }

    /**
     * @notice Verify an off-chain payload against the anchored hash.
     * @dev Lets a financier confirm the score they were shown matches
     *      what the attester committed on-chain, without trusting the
     *      presenter. Returns false (rather than reverting) when the
     *      subject was never scored.
     */
    function verifyPayload(address subject, bytes calldata payload)
        external
        view
        returns (bool)
    {
        Attestation memory a = _latest[subject];
        if (a.attestedAt == 0) return false;
        return keccak256(payload) == a.scoreHash;
    }
}
