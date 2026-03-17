// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/IOracle.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

interface IVault {
    function getTotalValueUsd() external view returns (uint256);
}

interface IFeeCollector {
    function totalProtocolFees(address token) external view returns (uint256);
}

contract ProtocolMetrics is Ownable {
    
    address public oracle;
    address public feeCollector;
    
    address[] public registeredVaults;
    mapping(address => bool) public isRegisteredVault;
    
    address[] public trackedTokens;
    mapping(address => bool) public isTrackedToken;
    
    uint256 public totalFeesCollectedAllTimeUsd;
    uint256 public lastFeeSnapshot;
    
    event VaultRegistered(address indexed vault);
    event VaultRemoved(address indexed vault);
    event TokenTracked(address indexed token);
    event TokenRemoved(address indexed token);
    event OracleUpdated(address indexed newOracle);
    event FeeCollectorUpdated(address indexed newFeeCollector);
    
    constructor(address _oracle, address _feeCollector) Ownable(msg.sender) {
        oracle = _oracle;
        feeCollector = _feeCollector;
    }
    
    function registerVault(address vault) external onlyOwner {
        require(vault != address(0), "Invalid vault");
        require(!isRegisteredVault[vault], "Already registered");
        
        registeredVaults.push(vault);
        isRegisteredVault[vault] = true;
        
        emit VaultRegistered(vault);
    }
    
    function removeVault(address vault) external onlyOwner {
        require(isRegisteredVault[vault], "Not registered");
        
        isRegisteredVault[vault] = false;
        
        for (uint256 i = 0; i < registeredVaults.length; i++) {
            if (registeredVaults[i] == vault) {
                registeredVaults[i] = registeredVaults[registeredVaults.length - 1];
                registeredVaults.pop();
                break;
            }
        }
        
        emit VaultRemoved(vault);
    }
    
    function trackToken(address token) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(!isTrackedToken[token], "Already tracked");
        
        trackedTokens.push(token);
        isTrackedToken[token] = true;
        
        emit TokenTracked(token);
    }
    
    function removeToken(address token) external onlyOwner {
        require(isTrackedToken[token], "Not tracked");
        
        isTrackedToken[token] = false;
        
        for (uint256 i = 0; i < trackedTokens.length; i++) {
            if (trackedTokens[i] == token) {
                trackedTokens[i] = trackedTokens[trackedTokens.length - 1];
                trackedTokens.pop();
                break;
            }
        }
        
        emit TokenRemoved(token);
    }
    
    function getTotalTVL() external view returns (uint256 totalTvl) {
        for (uint256 i = 0; i < registeredVaults.length; i++) {
            try IVault(registeredVaults[i]).getTotalValueUsd() returns (uint256 tvl) {
                totalTvl += tvl;
            } catch {}
        }
    }
    
    function getTotalFeesCollectedUsd() external view returns (uint256 totalFees) {
        if (feeCollector == address(0) || oracle == address(0)) return 0;
        
        for (uint256 i = 0; i < trackedTokens.length; i++) {
            address token = trackedTokens[i];
            uint256 feeAmount = IFeeCollector(feeCollector).totalProtocolFees(token);
            
            if (feeAmount > 0) {
                try IOracle(oracle).priceUsdE18(token) returns (uint256 price) {
                    uint8 decimals = IERC20Decimals(token).decimals();
                    totalFees += (feeAmount * price) / (10 ** decimals);
                } catch {}
            }
        }
    }
    
    function getVaultTVL(address vault) external view returns (uint256) {
        if (!isRegisteredVault[vault]) return 0;
        
        try IVault(vault).getTotalValueUsd() returns (uint256 tvl) {
            return tvl;
        } catch {
            return 0;
        }
    }
    
    function getProtocolStats() external view returns (
        uint256 totalTvl,
        uint256 totalFees,
        uint256 vaultCount,
        uint256 tokenCount
    ) {
        for (uint256 i = 0; i < registeredVaults.length; i++) {
            try IVault(registeredVaults[i]).getTotalValueUsd() returns (uint256 tvl) {
                totalTvl += tvl;
            } catch {}
        }
        
        if (feeCollector != address(0) && oracle != address(0)) {
            for (uint256 i = 0; i < trackedTokens.length; i++) {
                address token = trackedTokens[i];
                uint256 feeAmount = IFeeCollector(feeCollector).totalProtocolFees(token);
                
                if (feeAmount > 0) {
                    try IOracle(oracle).priceUsdE18(token) returns (uint256 price) {
                        uint8 decimals = IERC20Decimals(token).decimals();
                        totalFees += (feeAmount * price) / (10 ** decimals);
                    } catch {}
                }
            }
        }
        
        vaultCount = registeredVaults.length;
        tokenCount = trackedTokens.length;
    }
    
    function getAllVaults() external view returns (address[] memory) {
        return registeredVaults;
    }
    
    function getAllTrackedTokens() external view returns (address[] memory) {
        return trackedTokens;
    }
    
    function getVaultCount() external view returns (uint256) {
        return registeredVaults.length;
    }
    
    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }
    
    function setFeeCollector(address _feeCollector) external onlyOwner {
        require(_feeCollector != address(0), "Invalid fee collector");
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }
}
