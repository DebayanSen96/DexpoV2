// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBorrowHubCaller {
    function borrow(address vault, address token, uint256 amount, bytes32 adapterId) external returns (uint256);
    function repay(address vault, address token, uint256 amount) external returns (uint256);
}

contract MockBorrowVault {
    address public safe;
    uint256 public totalValueUsd;

    constructor(address _safe, uint256 _totalValueUsd) {
        safe = _safe;
        totalValueUsd = _totalValueUsd;
    }

    function setSafe(address _safe) external {
        safe = _safe;
    }

    function setTotalValueUsd(uint256 _totalValueUsd) external {
        totalValueUsd = _totalValueUsd;
    }

    function getTotalValueUsd() external view returns (uint256) {
        return totalValueUsd;
    }

    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function executeBorrow(address borrowHub, address token, uint256 amount, bytes32 adapterId) external returns (uint256) {
        return IBorrowHubCaller(borrowHub).borrow(address(this), token, amount, adapterId);
    }

    function executeRepay(address borrowHub, address token, uint256 amount) external returns (uint256) {
        return IBorrowHubCaller(borrowHub).repay(address(this), token, amount);
    }
}
