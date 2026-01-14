// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/IModuleRegistry.sol";

contract ModuleRegistry is IModuleRegistry, Ownable {
    address public swapModule;
    address public buySellModule;
    address public lendModule;
    address public borrowModule;
    address public stakingModule;
    address public oracle;
    
    mapping(bytes32 => address) public modules;
    mapping(address => bool) public isRegisteredModule;
    
    event SwapModuleUpdated(address indexed module);
    event BuySellModuleUpdated(address indexed module);
    event LendModuleUpdated(address indexed module);
    event BorrowModuleUpdated(address indexed module);
    event StakingModuleUpdated(address indexed module);
    event OracleUpdated(address indexed oracle);
    event ModuleRegistered(bytes32 indexed moduleId, address indexed module);
    event ModuleRemoved(bytes32 indexed moduleId, address indexed module);
    
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
    
    function getStakingModule() external view override returns (address) {
        return stakingModule;
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
    
    function setStakingModule(address module) external override onlyOwner {
        require(module != address(0), "Invalid module");
        stakingModule = module;
        emit StakingModuleUpdated(module);
    }
    
    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }
    
    function getOracle() external view returns (address) {
        return oracle;
    }
    
    function registerModule(bytes32 moduleId, address module) external onlyOwner {
        require(module != address(0), "Invalid module");
        address oldModule = modules[moduleId];
        if (oldModule != address(0)) {
            isRegisteredModule[oldModule] = false;
        }
        modules[moduleId] = module;
        isRegisteredModule[module] = true;
        emit ModuleRegistered(moduleId, module);
    }
    
    function removeModule(bytes32 moduleId) external onlyOwner {
        address module = modules[moduleId];
        require(module != address(0), "Module not found");
        isRegisteredModule[module] = false;
        delete modules[moduleId];
        emit ModuleRemoved(moduleId, module);
    }
    
    function getModule(bytes32 moduleId) external view returns (address) {
        return modules[moduleId];
    }
}
