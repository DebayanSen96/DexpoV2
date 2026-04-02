// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockModuleRegistryV3 {
    address public oracle;
    address public swapModule;
    address public stakingModule;
    address public lendModule;
    address public borrowModule;

    constructor(address _oracle) {
        oracle = _oracle;
    }

    function getOracle() external view returns (address) {
        return oracle;
    }

    function getSwapModule() external view returns (address) {
        return swapModule;
    }

    function getStakingModule() external view returns (address) {
        return stakingModule;
    }

    function getLendModule() external view returns (address) {
        return lendModule;
    }

    function getBorrowModule() external view returns (address) {
        return borrowModule;
    }
}
