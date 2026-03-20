// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface IModuleRegistryFactory {
    function getLendModule() external view returns (address);
    function getBorrowModule() external view returns (address);
}

interface IIndexSwapV3Init {
    struct TokenWeight {
        address token;
        uint16 weightBps;
    }
    
    struct InitParams {
        address protocolCore;
        address vaultOwner;
        address moduleRegistry;
        address feeCollector;
        address lendModule;
        address borrowModule;
        uint16 performanceFeeBps;
        uint256 lockupSeconds;
    }
    
    function initialize(
        InitParams calldata params,
        string calldata _name,
        string calldata _symbol,
        TokenWeight[] calldata _portfolio
    ) external;
}

contract IndexSwapFactory is Ownable {
    
    address public immutable protocolCore;
    address public immutable moduleRegistry;
    address public implementation;
    address public feeCollector;
    
    uint256 public vaultCount;
    mapping(uint256 => address) public vaults;
    
    event VaultCreated(
        uint256 indexed vaultId,
        address indexed vaultOwner,
        address indexed indexSwap
    );
    event FeeCollectorUpdated(address indexed newFeeCollector);
    event ImplementationUpdated(address indexed newImplementation);
    
    error OnlyProtocolCore();
    error ZeroAddress();
    error EmptyPortfolio();
    error FeeCollectorNotSet();
    error ImplementationNotSet();
    
    constructor(
        address _protocolCore,
        address _moduleRegistry,
        address _implementation,
        address _feeCollector
    ) Ownable(msg.sender) {
        require(_protocolCore != address(0) && _moduleRegistry != address(0), "Zero");
        protocolCore = _protocolCore;
        moduleRegistry = _moduleRegistry;
        implementation = _implementation;
        feeCollector = _feeCollector;
    }
    
    modifier onlyProtocolCore() {
        if (msg.sender != protocolCore) revert OnlyProtocolCore();
        _;
    }
    
    struct TokenWeight {
        address token;
        uint16 weightBps;
    }
    
    function createVault(
        address vaultOwner,
        string calldata name,
        string calldata symbol,
        TokenWeight[] calldata portfolio,
        uint256 lockupSeconds,
        uint16 performanceFeeBps
    ) external onlyProtocolCore returns (address indexSwap) {
        if (vaultOwner == address(0)) revert ZeroAddress();
        if (portfolio.length == 0) revert EmptyPortfolio();
        if (feeCollector == address(0)) revert FeeCollectorNotSet();
        if (implementation == address(0)) revert ImplementationNotSet();
        
        IIndexSwapV3Init.TokenWeight[] memory portfolioInit = new IIndexSwapV3Init.TokenWeight[](portfolio.length);
        for (uint256 i; i < portfolio.length; ++i) {
            portfolioInit[i].token = portfolio[i].token;
            portfolioInit[i].weightBps = portfolio[i].weightBps;
        }
        
        bytes memory initData = abi.encodeCall(
            IIndexSwapV3Init.initialize,
            (
                IIndexSwapV3Init.InitParams({
                    protocolCore: protocolCore,
                    vaultOwner: vaultOwner,
                    moduleRegistry: moduleRegistry,
                    feeCollector: feeCollector,
                    lendModule: IModuleRegistryFactory(moduleRegistry).getLendModule(),
                    borrowModule: IModuleRegistryFactory(moduleRegistry).getBorrowModule(),
                    performanceFeeBps: performanceFeeBps,
                    lockupSeconds: lockupSeconds
                }),
                name,
                symbol,
                portfolioInit
            )
        );
        indexSwap = address(new ERC1967Proxy(implementation, initData));
        
        vaults[vaultCount] = indexSwap;
        emit VaultCreated(vaultCount++, vaultOwner, indexSwap);
    }
    
    function setImplementation(address _implementation) external onlyOwner {
        if (_implementation == address(0)) revert ZeroAddress();
        implementation = _implementation;
        emit ImplementationUpdated(_implementation);
    }
    
    function setFeeCollector(address _feeCollector) external onlyOwner {
        if (_feeCollector == address(0)) revert ZeroAddress();
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }
}
