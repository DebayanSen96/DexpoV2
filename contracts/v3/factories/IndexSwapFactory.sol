// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../vault/VaultSafe.sol";
import "../vault/IndexSwap.sol";
import "../interfaces/IProtocolCore.sol";

interface IModuleRegistry {
    function getSwapModule() external view returns (address);
    function getBuySellModule() external view returns (address);
    function getLendModule() external view returns (address);
    function getBorrowModule() external view returns (address);
}

contract IndexSwapFactory is Ownable {
    address public immutable protocolCore;
    address public immutable moduleRegistry;
    address public defaultSwapRouter;
    
    uint256 public vaultCount;
    
    struct VaultDeployment {
        address safe;
        address indexSwap;
        address owner;
        uint256 farmId;
    }
    
    mapping(uint256 => VaultDeployment) public vaults;
    mapping(address => uint256[]) public vaultsByOwner;
    
    event VaultCreated(
        uint256 indexed vaultId,
        address indexed safe,
        address indexed indexSwap,
        address owner,
        uint256 farmId
    );
    
    constructor(
        address _protocolCore,
        address _moduleRegistry,
        address _defaultSwapRouter
    ) Ownable(msg.sender) {
        require(_protocolCore != address(0), "Invalid core");
        require(_moduleRegistry != address(0), "Invalid registry");
        require(_defaultSwapRouter != address(0), "Invalid router");
        
        protocolCore = _protocolCore;
        moduleRegistry = _moduleRegistry;
        defaultSwapRouter = _defaultSwapRouter;
    }
    
    struct TokenWeight {
        address token;
        uint16 weightBps;
    }
    
    function createVault(
        address[] calldata safeOwners,
        uint256 safeThreshold,
        string calldata name,
        string calldata symbol,
        TokenWeight[] calldata portfolio,
        uint256 farmId,
        address customSwapRouter,
        uint256 lockupSeconds
    ) external returns (address safe, address indexSwap) {
        require(safeOwners.length > 0, "No owners");
        require(portfolio.length > 0, "Empty portfolio");
        
        address swapRouter = customSwapRouter != address(0) ? customSwapRouter : defaultSwapRouter;
        
        VaultSafe vaultSafe = new VaultSafe(
            protocolCore,
            safeOwners,
            safeThreshold
        );
        safe = address(vaultSafe);
        
        IndexSwap vault = new IndexSwap(
            protocolCore,
            safe,
            swapRouter,
            name,
            symbol,
            _convertPortfolio(portfolio),
            lockupSeconds
        );
        indexSwap = address(vault);
        
        address lendModule = IModuleRegistry(moduleRegistry).getLendModule();
        address borrowModule = IModuleRegistry(moduleRegistry).getBorrowModule();
        vault.setModules(lendModule, borrowModule);
        
        uint256 vaultId = vaultCount++;
        vaults[vaultId] = VaultDeployment({
            safe: safe,
            indexSwap: indexSwap,
            owner: safeOwners[0],
            farmId: farmId
        });
        
        vaultsByOwner[safeOwners[0]].push(vaultId);
        
        if (farmId > 0 && protocolCore != address(0)) {
            (bool success, ) = protocolCore.call(
                abi.encodeWithSignature(
                    "registerFarm(address,address,uint256)",
                    safeOwners[0],
                    indexSwap,
                    farmId
                )
            );
            require(success, "Farm registration failed");
        }
        
        emit VaultCreated(vaultId, safe, indexSwap, safeOwners[0], farmId);
    }
    
    function setDefaultSwapRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid router");
        defaultSwapRouter = _router;
    }
    
    function getVaultsByOwner(address owner) external view returns (uint256[] memory) {
        return vaultsByOwner[owner];
    }
    
    function getVaultDeployment(uint256 vaultId) external view returns (
        address safe,
        address indexSwap,
        address owner,
        uint256 farmId
    ) {
        VaultDeployment memory deployment = vaults[vaultId];
        return (deployment.safe, deployment.indexSwap, deployment.owner, deployment.farmId);
    }
    
    function _convertPortfolio(TokenWeight[] calldata portfolio) internal pure returns (IndexSwap.TokenWeight[] memory) {
        IndexSwap.TokenWeight[] memory result = new IndexSwap.TokenWeight[](portfolio.length);
        for (uint256 i = 0; i < portfolio.length; i++) {
            result[i].token = portfolio[i].token;
            result[i].weightBps = portfolio[i].weightBps;
        }
        return result;
    }
}
