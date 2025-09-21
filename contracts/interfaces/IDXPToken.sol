// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";


/// @title IDXPToken
/// @notice Minimal interface for the Dexponent Token (DXPToken) used in the protocol.
///         Exposes standard ERC20 and owner-only mint.
interface IDXPToken is IERC20 {
    function mint(address to, uint256 amount) external;
}
