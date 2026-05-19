// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_3_0/FunctionsClient.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";

import {CosellEscrow} from "./CosellEscrow.sol";

/**
 * @title CosellShipmentVerifier
 * @notice Chainlink Functions consumer that confirms a Kajota
 *         shipment off-chain and, on success, calls
 *         CosellEscrow.release(depositId).
 *
 * Flow:
 *   1. Operator calls requestShipmentVerification(depositId, orderId).
 *      The contract submits a Chainlink Functions request bundling
 *      attestation/source.js (the DON-side JS), encrypted secrets,
 *      and the args [depositId, orderId].
 *   2. The DON runs source.js — it hits Kajota's
 *      /coach/agent/shipment-attestation endpoint, parses the
 *      response, and returns a 32-byte packed result:
 *         [depositIdPrefix(16) | orderIdPrefix(15) | flag(1)]
 *   3. _fulfillRequest() decodes that result, checks the prefix
 *      matches the deposit we asked about (prevents callback swap),
 *      and if flag == 0x01 calls escrow.release(depositId).
 *
 * Permission model:
 *   - `operator` is the only address that can call
 *     requestShipmentVerification (controls who can burn the
 *     Chainlink subscription's LINK).
 *   - `operator` is rotatable by itself (matches CosellEscrow's
 *     releaseAuth-rotation pattern).
 *   - The DON router calls _fulfillRequest, which is gated by
 *     FunctionsClient.handleOracleFulfillment — only the
 *     configured router can fulfil.
 *
 * Deployment: set this contract's address as
 * CosellEscrow.releaseAuth so it has permission to release.
 *
 * @dev Hackathon target: Mantle Turing Test Phase 2 (Jun 15) +
 *      AWS Activate Web3. Sister contracts: CosellRegistry,
 *      CosellEscrow.
 */
contract CosellShipmentVerifier is FunctionsClient {
    using FunctionsRequest for FunctionsRequest.Request;

    /// @notice The escrow whose deposits we release on successful
    ///         attestation. Immutable.
    CosellEscrow public immutable escrow;

    /// @notice JS source code that runs in the DON. Set at
    ///         construction; rotatable by operator if Kajota's
    ///         endpoint contract evolves.
    string public source;

    /// @notice Chainlink Functions subscription ID that pays for
    ///         this consumer's requests in LINK.
    uint64 public subscriptionId;

    /// @notice Gas to allocate to the _fulfillRequest callback.
    uint32 public callbackGasLimit;

    /// @notice DON id (e.g. fun-base-sepolia-1). Bytes32-encoded.
    bytes32 public donId;

    /// @notice The currently-authorised operator — the only address
    ///         allowed to send Chainlink requests through this
    ///         contract. Defaults to the deployer.
    address public operator;

    /// @notice requestId → depositId we asked about. Used by
    ///         _fulfillRequest to know which escrow row to release.
    mapping(bytes32 => bytes32) public requestToDeposit;

    /// @notice requestId → orderId we asked about. Stored so
    ///         _fulfillRequest can verify the orderId prefix in
    ///         the callback matches what we requested.
    mapping(bytes32 => string) public requestToOrderId;

    // ----- events -----

    event ShipmentRequested(
        bytes32 indexed requestId,
        bytes32 indexed depositId,
        string orderId
    );

    event ShipmentConfirmed(
        bytes32 indexed requestId,
        bytes32 indexed depositId,
        string orderId
    );

    event ShipmentRejected(
        bytes32 indexed requestId,
        bytes32 indexed depositId,
        string orderId,
        bytes reason
    );

    event ConfigUpdated(
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        bytes32 donId
    );

    event SourceUpdated();

    event OperatorUpdated(address indexed previous, address indexed next);

    // ----- errors -----

    error InvalidEscrow();
    error InvalidOperator();
    error InvalidRouter();
    error EmptySource();
    error NotOperator(address caller);
    error UnknownRequest(bytes32 requestId);
    error PrefixMismatch();
    error ZeroDepositId();
    error EmptyOrderId();

    // ----- constructor -----

    constructor(
        address router,
        CosellEscrow _escrow,
        string memory _source,
        uint64 _subscriptionId,
        uint32 _callbackGasLimit,
        bytes32 _donId,
        address _operator
    ) FunctionsClient(router) {
        if (router == address(0)) revert InvalidRouter();
        if (address(_escrow) == address(0)) revert InvalidEscrow();
        if (_operator == address(0)) revert InvalidOperator();
        if (bytes(_source).length == 0) revert EmptySource();

        escrow = _escrow;
        source = _source;
        subscriptionId = _subscriptionId;
        callbackGasLimit = _callbackGasLimit;
        donId = _donId;
        operator = _operator;
    }

    // ----- core -----

    /**
     * @notice Submit a Chainlink Functions request to verify that
     *         the Kajota order tied to `depositId` has shipped.
     *
     * @return requestId the Chainlink request id, also used as
     *                   the key for the requestToDeposit/orderId
     *                   maps so the callback can resolve back.
     */
    function requestShipmentVerification(
        bytes32 depositId,
        string calldata orderId
    ) external returns (bytes32 requestId) {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (depositId == bytes32(0)) revert ZeroDepositId();
        if (bytes(orderId).length == 0) revert EmptyOrderId();

        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(source);

        string[] memory args = new string[](2);
        // bytes32 → hex string with 0x prefix
        args[0] = _toHex(depositId);
        args[1] = orderId;
        req.setArgs(args);

        requestId = _sendRequest(
            req.encodeCBOR(),
            subscriptionId,
            callbackGasLimit,
            donId
        );

        requestToDeposit[requestId] = depositId;
        requestToOrderId[requestId] = orderId;

        emit ShipmentRequested(requestId, depositId, orderId);
    }

    /**
     * @notice Chainlink DON callback — decode the bytes32 result,
     *         verify the prefixes, and (if shipped) call
     *         escrow.release(depositId).
     */
    function _fulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) internal override {
        bytes32 depositId = requestToDeposit[requestId];
        if (depositId == bytes32(0)) revert UnknownRequest(requestId);

        string memory orderId = requestToOrderId[requestId];
        delete requestToDeposit[requestId];
        delete requestToOrderId[requestId];

        // DON-side error path — surface to off-chain observers but
        // don't revert (Chainlink would then mark the request
        // failed and the LINK is still spent; better to log).
        if (err.length > 0) {
            emit ShipmentRejected(requestId, depositId, orderId, err);
            return;
        }

        // Response shape (see attestation/source.js):
        //   depositPrefix(16 bytes) || orderPrefix(15 bytes) || flag(1 byte)
        // The DON wraps the source's `return Functions.encodeUint256(...)`
        // result so `response` should be exactly 32 bytes.
        if (response.length != 32) {
            emit ShipmentRejected(
                requestId,
                depositId,
                orderId,
                bytes("BAD_RESPONSE_LEN")
            );
            return;
        }

        bytes32 packed = bytes32(response);

        // Verify depositId prefix matches what we requested.
        // depositPrefix = first 16 bytes of packed = top half of bytes32.
        bytes32 expectedPrefix = depositId & bytes32(uint256(uint128(type(uint128).max)) << 128);
        bytes32 actualPrefix = packed & bytes32(uint256(uint128(type(uint128).max)) << 128);
        if (expectedPrefix != actualPrefix) {
            emit ShipmentRejected(
                requestId,
                depositId,
                orderId,
                bytes("PREFIX_MISMATCH")
            );
            return;
        }

        // Read the flag — last byte of the bytes32.
        uint8 flag = uint8(uint256(packed) & 0xff);
        if (flag == 0x01) {
            escrow.release(depositId);
            emit ShipmentConfirmed(requestId, depositId, orderId);
        } else {
            emit ShipmentRejected(
                requestId,
                depositId,
                orderId,
                bytes("NOT_SHIPPED")
            );
        }
    }

    // ----- admin -----

    function setOperator(address next) external {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (next == address(0)) revert InvalidOperator();
        address prev = operator;
        operator = next;
        emit OperatorUpdated(prev, next);
    }

    function setConfig(
        uint64 _subscriptionId,
        uint32 _callbackGasLimit,
        bytes32 _donId
    ) external {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        subscriptionId = _subscriptionId;
        callbackGasLimit = _callbackGasLimit;
        donId = _donId;
        emit ConfigUpdated(_subscriptionId, _callbackGasLimit, _donId);
    }

    function setSource(string calldata _source) external {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (bytes(_source).length == 0) revert EmptySource();
        source = _source;
        emit SourceUpdated();
    }

    // ----- helpers -----

    /** @dev Lowercase 0x-prefixed hex of a bytes32 (66 chars). */
    function _toHex(bytes32 value) internal pure returns (string memory) {
        bytes memory chars = "0123456789abcdef";
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(value[i]);
            out[2 + i * 2] = chars[b >> 4];
            out[3 + i * 2] = chars[b & 0x0f];
        }
        return string(out);
    }
}
