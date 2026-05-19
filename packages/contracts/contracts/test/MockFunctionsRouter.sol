// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/interfaces/IFunctionsClient.sol";

/**
 * @title MockFunctionsRouter
 * @notice Minimal stand-in for the Chainlink Functions Router used
 *         in unit tests. Records every request so the test can
 *         look up the requestId, then exposes `fulfill(...)` to
 *         simulate the DON callback.
 *
 * Why a custom mock vs. the official toolkit: Chainlink's
 * functions-toolkit npm package is a Node CLI for local
 * simulation + on-chain interaction. It does not ship a
 * Solidity router mock suitable for hardhat-test reverts; we
 * get one in <40 lines by re-implementing only the surface
 * FunctionsClient.sendRequest touches (and the
 * IFunctionsClient.handleOracleFulfillment callback shape).
 *
 * @dev Test-only. Lives under contracts/test/ so the deploy
 *      script never picks it up.
 */
contract MockFunctionsRouter {
    /// Auto-incrementing requestId source — easier than emulating
    /// the real router's request scheduling.
    uint256 private _nonce;

    /// Last requestId returned by sendRequest. Tests typically only
    /// care about the most recent one.
    bytes32 public lastRequestId;

    /// requestId → consumer that submitted it.
    mapping(bytes32 => address) public consumerFor;

    event RequestRouted(bytes32 indexed requestId, address indexed consumer);

    /**
     * @notice Mimic Router.sendRequest's signature shape used by
     *         FunctionsClient._sendRequest.
     */
    function sendRequest(
        uint64,                  /* subscriptionId */
        bytes calldata,          /* data (CBOR) */
        uint16,                  /* dataVersion */
        uint32,                  /* callbackGasLimit */
        bytes32                  /* donId */
    ) external returns (bytes32 requestId) {
        _nonce++;
        requestId = keccak256(abi.encodePacked(_nonce, msg.sender));
        consumerFor[requestId] = msg.sender;
        lastRequestId = requestId;
        emit RequestRouted(requestId, msg.sender);
    }

    /**
     * @notice Test-only helper: simulate the DON delivering a result.
     * @dev The real router calls IFunctionsClient.handleOracleFulfillment
     *      with (requestId, response, err). FunctionsClient internally
     *      calls _fulfillRequest with the same args.
     */
    function fulfill(
        bytes32 requestId,
        bytes calldata response,
        bytes calldata err
    ) external {
        address consumer = consumerFor[requestId];
        require(consumer != address(0), "MockFunctionsRouter: unknown requestId");
        IFunctionsClient(consumer).handleOracleFulfillment(requestId, response, err);
    }
}
