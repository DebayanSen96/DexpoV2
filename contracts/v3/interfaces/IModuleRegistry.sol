// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IModuleRegistry {
    function getSwapModule() external view returns (address);
    function getBuySellModule() external view returns (address);
    function getLendModule() external view returns (address);
    function getBorrowModule() external view returns (address);
    function getStakingModule() external view returns (address);
    
    function setSwapModule(address module) external;
    function setBuySellModule(address module) external;
    function setLendModule(address module) external;
    function setBorrowModule(address module) external;
    function setStakingModule(address module) external;
}
