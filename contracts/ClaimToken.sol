// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/BaseClaimToken.sol";
/**
 * @title FarmClaimToken
 * @notice A standard claim token representing a user's share of principal deposited into a Farm.
 *         Inherits the base logic. Could add farm-specific penalty logic or none at all.
 */
contract FarmClaimToken is BaseClaimToken {
    // Additional farm-specific data or references can go here, if needed.

    /// @notice Deploy a claim token bound to a specific minter (typically the farm).
    /// @dev The minter is allowed to mint/burn on deposit/withdraw flows.
    /// @param _name   ERC-20 name for the claim token.
    /// @param _symbol ERC-20 symbol for the claim token.
    /// @param _minter Address authorized to mint/burn claim tokens.
    constructor(
        string memory _name,
        string memory _symbol,
        address _minter
    ) BaseClaimToken(_name, _symbol, _minter) Ownable(msg.sender) {
        // Initialize the claim token with the minter and other parameters.
    }

    // Add farm-specific logic if needed
    // e.g., restricting certain transfers or applying early withdrawal fees.
}
