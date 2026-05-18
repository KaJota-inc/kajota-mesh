// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice 6-decimal mock of Circle's USDC for CosellEscrow tests.
 *
 * `decimals()` is overridden to 6 to match real USDC — important
 * because the escrow's split math is in token base units and would
 * read differently against an 18-decimal token.
 *
 * NOT FOR DEPLOYMENT — only ever imported by tests. Lives under
 * `contracts/test/` so the deploy script never picks it up.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
