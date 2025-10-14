// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title USDX
 * @dev Basic mintable ERC20 with permit. Owner can mint arbitrarily; no fixed supply.
 */
contract USDX is ERC20, ERC20Permit, Ownable {
    constructor()
        ERC20("USDX Token", "USDx")
        ERC20Permit("USDX Token")
        Ownable(msg.sender)
    {}

    /**
     * @notice Mint tokens to an address. Only owner can mint.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
