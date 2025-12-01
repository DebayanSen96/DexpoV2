// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IModuleRegistry.sol";

contract ModuleRegistry is IModuleRegistry, Ownable {
    address public swapModule;
    address public buySellModule;
    address public lendModule;
    address public borrowModule;
    
    event SwapModuleUpdated(address indexed module);
    event BuySellModuleUpdated(address indexed module);
    event LendModuleUpdated(address indexed module);
    event BorrowModuleUpdated(address indexed module);
    
    constructor() Ownable(msg.sender) {}
    
    function getSwapModule() external view override returns (address) {
        return swapModule;
    }
    
    function getBuySellModule() external view override returns (address) {
        return buySellModule;
    }
    
    function getLendModule() external view override returns (address) {
        return lendModule;
    }
    
    function getBorrowModule() external view override returns (address) {
        return borrowModule;
    }
    
    function setSwapModule(address module) external override onlyOwner {
        require(module != address(0), "Invalid module");
        swapModule = module;
        emit SwapModuleUpdated(module);
    }
    
    function setBuySellModule(address module) external override onlyOwner {
        require(module != address(0), "Invalid module");
        buySellModule = module;
        emit BuySellModuleUpdated(module);
    }
    
    function setLendModule(address module) external override onlyOwner {
        require(module != address(0), "Invalid module");
        lendModule = module;
        emit LendModuleUpdated(module);
    }
    
    function setBorrowModule(address module) external override onlyOwner {
        require(module != address(0), "Invalid module");
        borrowModule = module;
        emit BorrowModuleUpdated(module);
    }
}
