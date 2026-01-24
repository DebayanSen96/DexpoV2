// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../mainnet/vault/IndexSwapV3.sol";

interface IModuleRegistryFactory {
    function getLendModule() external view returns (address);
    function getBorrowModule() external view returns (address);
}

contract IndexSwapFactory is Ownable {
    address public immutable protocolCore;
    address public immutable moduleRegistry;
    address public defaultSwapRouter;
    
    uint256 public vaultCount;
    
    event VaultCreated(
        uint256 indexed vaultId,
        address indexed owner,
        address indexed indexSwap
    );
    
    constructor(
        address _protocolCore,
        address _moduleRegistry,
        address _defaultSwapRouter
    ) Ownable(msg.sender) {
        require(_protocolCore != address(0) && _moduleRegistry != address(0) && _defaultSwapRouter != address(0), "Zero");
        protocolCore = _protocolCore;
        moduleRegistry = _moduleRegistry;
        defaultSwapRouter = _defaultSwapRouter;
    }
    
    struct TokenWeight {
        address token;
        uint16 weightBps;
    }
    
    function createVault(
        address owner,
        string calldata name,
        string calldata symbol,
        TokenWeight[] calldata portfolio,
        address customSwapRouter,
        uint256 lockupSeconds
    ) external returns (address indexSwap) {
        require(owner != address(0), "Zero owner");
        require(portfolio.length > 0, "Empty");
        
        IndexSwapV3 vault = new IndexSwapV3(
            protocolCore,
            owner,
            moduleRegistry,
            name,
            symbol,
            _toPortfolio(portfolio),
            lockupSeconds
        );
        indexSwap = address(vault);

        vault.setModules(
            IModuleRegistryFactory(moduleRegistry).getLendModule(),
            IModuleRegistryFactory(moduleRegistry).getBorrowModule()
        );
        
        emit VaultCreated(vaultCount++, owner, indexSwap);
    }
    
    function setDefaultSwapRouter(address _router) external onlyOwner {
        require(_router != address(0), "Zero");
        defaultSwapRouter = _router;
    }
    
    function _toPortfolio(TokenWeight[] calldata p) internal pure returns (IndexSwapV3.TokenWeight[] memory r) {
        r = new IndexSwapV3.TokenWeight[](p.length);
        for (uint256 i; i < p.length; ++i) {
            r[i].token = p[i].token;
            r[i].weightBps = p[i].weightBps;
        }
    }
}
