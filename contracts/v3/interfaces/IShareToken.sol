// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IShareToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;

    // Transfer controls
    function setTransferable(bool transferable) external;
    function setTransferFeeBps(uint16 bps) external; // capped by vault/factory
    function setFeeReceiver(address receiver) external; // typically farm owner
}
