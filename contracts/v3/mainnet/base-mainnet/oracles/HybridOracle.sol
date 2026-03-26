// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../../interfaces/IOracle.sol";

interface IChainlinkOracle {
    function priceUsdE18(address token) external view returns (uint256);
    function hasPriceFeed(address token) external view returns (bool);
}

interface ITWAPOracle {
    function priceUsdE18(address token) external view returns (uint256);
    function hasPriceFeed(address token) external view returns (bool);
}

contract HybridOracle is IOracle, Ownable {
    
    address public chainlinkOracle;
    address public twapOracle;
    
    struct OracleConfig {
        bool useChainlink;
        bool useTWAP;
        uint16 maxDeviationBps;
        bool requireBothSources;
        bool enabled;
    }
    
    mapping(address => OracleConfig) public tokenConfigs;
    
    uint16 public defaultMaxDeviationBps = 500; // 5% default
    uint16 public constant BPS_DIVISOR = 10000;
    
    bool public circuitBreakerEnabled = true;
    mapping(address => bool) public circuitBreakerTriggered;
    
    event ChainlinkOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event TWAPOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event TokenConfigured(
        address indexed token,
        bool useChainlink,
        bool useTWAP,
        uint16 maxDeviationBps,
        bool requireBothSources
    );
    event TokenDisabled(address indexed token);
    event DefaultDeviationUpdated(uint16 oldBps, uint16 newBps);
    event CircuitBreakerToggled(bool enabled);
    event CircuitBreakerTriggered(address indexed token, uint256 chainlinkPrice, uint256 twapPrice, uint256 deviationBps);
    event CircuitBreakerReset(address indexed token);
    
    error NoPriceFeed(address token);
    error CircuitBreakerActive(address token);
    error DeviationTooHigh(address token, uint256 chainlinkPrice, uint256 twapPrice, uint256 deviationBps);
    error BothSourcesRequired(address token);
    error InvalidPrice();
    error ZeroAddress();

    constructor(address _chainlinkOracle, address _twapOracle) Ownable(msg.sender) {
        chainlinkOracle = _chainlinkOracle;
        twapOracle = _twapOracle;
    }

    function setChainlinkOracle(address _oracle) external onlyOwner {
        address old = chainlinkOracle;
        chainlinkOracle = _oracle;
        emit ChainlinkOracleUpdated(old, _oracle);
    }

    function setTWAPOracle(address _oracle) external onlyOwner {
        address old = twapOracle;
        twapOracle = _oracle;
        emit TWAPOracleUpdated(old, _oracle);
    }

    function configureToken(
        address token,
        bool useChainlink,
        bool useTWAP,
        uint16 maxDeviationBps,
        bool requireBothSources
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        require(useChainlink || useTWAP, "At least one source required");
        
        if (maxDeviationBps == 0) {
            maxDeviationBps = defaultMaxDeviationBps;
        }
        
        tokenConfigs[token] = OracleConfig({
            useChainlink: useChainlink,
            useTWAP: useTWAP,
            maxDeviationBps: maxDeviationBps,
            requireBothSources: requireBothSources,
            enabled: true
        });
        
        emit TokenConfigured(token, useChainlink, useTWAP, maxDeviationBps, requireBothSources);
    }

    function configureTokensBatch(
        address[] calldata tokens,
        bool[] calldata useChainlink,
        bool[] calldata useTWAP,
        uint16[] calldata maxDeviationBps,
        bool[] calldata requireBothSources
    ) external onlyOwner {
        require(
            tokens.length == useChainlink.length &&
            tokens.length == useTWAP.length &&
            tokens.length == maxDeviationBps.length &&
            tokens.length == requireBothSources.length,
            "Length mismatch"
        );
        
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            require(useChainlink[i] || useTWAP[i], "At least one source required");
            
            uint16 deviation = maxDeviationBps[i] == 0 ? defaultMaxDeviationBps : maxDeviationBps[i];
            
            tokenConfigs[tokens[i]] = OracleConfig({
                useChainlink: useChainlink[i],
                useTWAP: useTWAP[i],
                maxDeviationBps: deviation,
                requireBothSources: requireBothSources[i],
                enabled: true
            });
            
            emit TokenConfigured(tokens[i], useChainlink[i], useTWAP[i], deviation, requireBothSources[i]);
        }
    }

    function disableToken(address token) external onlyOwner {
        tokenConfigs[token].enabled = false;
        emit TokenDisabled(token);
    }

    function setDefaultMaxDeviation(uint16 _deviationBps) external onlyOwner {
        require(_deviationBps <= 2000, "Deviation too high"); // Max 20%
        uint16 old = defaultMaxDeviationBps;
        defaultMaxDeviationBps = _deviationBps;
        emit DefaultDeviationUpdated(old, _deviationBps);
    }

    function setCircuitBreakerEnabled(bool _enabled) external onlyOwner {
        circuitBreakerEnabled = _enabled;
        emit CircuitBreakerToggled(_enabled);
    }

    function resetCircuitBreaker(address token) external onlyOwner {
        circuitBreakerTriggered[token] = false;
        emit CircuitBreakerReset(token);
    }

    function priceUsdE18(address token) external view override returns (uint256) {
        if (circuitBreakerEnabled && circuitBreakerTriggered[token]) {
            revert CircuitBreakerActive(token);
        }
        
        OracleConfig storage config = tokenConfigs[token];
        
        if (!config.enabled) {
            revert NoPriceFeed(token);
        }
        
        uint256 chainlinkPrice = 0;
        uint256 twapPrice = 0;
        bool hasChainlink = false;
        bool hasTWAP = false;
        
        if (config.useChainlink && chainlinkOracle != address(0)) {
            try IChainlinkOracle(chainlinkOracle).priceUsdE18(token) returns (uint256 price) {
                if (price > 0) {
                    chainlinkPrice = price;
                    hasChainlink = true;
                }
            } catch {}
        }
        
        if (config.useTWAP && twapOracle != address(0)) {
            try ITWAPOracle(twapOracle).priceUsdE18(token) returns (uint256 price) {
                if (price > 0) {
                    twapPrice = price;
                    hasTWAP = true;
                }
            } catch {}
        }
        
        if (config.requireBothSources && (!hasChainlink || !hasTWAP)) {
            revert BothSourcesRequired(token);
        }
        
        if (!hasChainlink && !hasTWAP) {
            revert NoPriceFeed(token);
        }
        
        if (hasChainlink && hasTWAP) {
            uint256 deviationBps = _calculateDeviation(chainlinkPrice, twapPrice);
            
            if (deviationBps > config.maxDeviationBps) {
                revert DeviationTooHigh(token, chainlinkPrice, twapPrice, deviationBps);
            }
            
            return chainlinkPrice;
        }
        
        if (hasChainlink) {
            return chainlinkPrice;
        }
        
        return twapPrice;
    }

    function getPrice(address token) external view override returns (uint256 price, uint8 decimals) {
        price = this.priceUsdE18(token);
        decimals = 18;
    }

    function getPriceWithSource(address token) external view returns (
        uint256 price,
        string memory source,
        uint256 chainlinkPrice,
        uint256 twapPrice
    ) {
        OracleConfig storage config = tokenConfigs[token];
        
        if (!config.enabled) {
            revert NoPriceFeed(token);
        }
        
        bool hasChainlink = false;
        bool hasTWAP = false;
        
        if (config.useChainlink && chainlinkOracle != address(0)) {
            try IChainlinkOracle(chainlinkOracle).priceUsdE18(token) returns (uint256 p) {
                if (p > 0) {
                    chainlinkPrice = p;
                    hasChainlink = true;
                }
            } catch {}
        }
        
        if (config.useTWAP && twapOracle != address(0)) {
            try ITWAPOracle(twapOracle).priceUsdE18(token) returns (uint256 p) {
                if (p > 0) {
                    twapPrice = p;
                    hasTWAP = true;
                }
            } catch {}
        }
        
        if (hasChainlink && hasTWAP) {
            price = chainlinkPrice;
            source = "Chainlink+TWAP";
        } else if (hasChainlink) {
            price = chainlinkPrice;
            source = "Chainlink";
        } else if (hasTWAP) {
            price = twapPrice;
            source = "TWAP";
        } else {
            revert NoPriceFeed(token);
        }
    }

    function triggerCircuitBreaker(address token) external onlyOwner {
        OracleConfig storage config = tokenConfigs[token];
        require(config.enabled, "Token not configured");
        require(config.useChainlink && config.useTWAP, "Both sources required for circuit breaker");
        
        uint256 chainlinkPrice = 0;
        uint256 twapPrice = 0;
        
        if (chainlinkOracle != address(0)) {
            try IChainlinkOracle(chainlinkOracle).priceUsdE18(token) returns (uint256 p) {
                chainlinkPrice = p;
            } catch {}
        }
        
        if (twapOracle != address(0)) {
            try ITWAPOracle(twapOracle).priceUsdE18(token) returns (uint256 p) {
                twapPrice = p;
            } catch {}
        }
        
        if (chainlinkPrice > 0 && twapPrice > 0) {
            uint256 deviationBps = _calculateDeviation(chainlinkPrice, twapPrice);
            
            if (deviationBps > config.maxDeviationBps) {
                circuitBreakerTriggered[token] = true;
                emit CircuitBreakerTriggered(token, chainlinkPrice, twapPrice, deviationBps);
            }
        }
    }

    function _calculateDeviation(uint256 price1, uint256 price2) internal pure returns (uint256) {
        if (price1 == 0 || price2 == 0) return BPS_DIVISOR;
        
        uint256 diff = price1 > price2 ? price1 - price2 : price2 - price1;
        uint256 avg = (price1 + price2) / 2;
        
        return (diff * BPS_DIVISOR) / avg;
    }

    function hasPriceFeed(address token) external view returns (bool) {
        OracleConfig storage config = tokenConfigs[token];
        if (!config.enabled) return false;
        
        bool hasChainlink = false;
        bool hasTWAP = false;
        
        if (config.useChainlink && chainlinkOracle != address(0)) {
            try IChainlinkOracle(chainlinkOracle).hasPriceFeed(token) returns (bool has) {
                hasChainlink = has;
            } catch {}
        }
        
        if (config.useTWAP && twapOracle != address(0)) {
            try ITWAPOracle(twapOracle).hasPriceFeed(token) returns (bool has) {
                hasTWAP = has;
            } catch {}
        }
        
        if (config.requireBothSources) {
            return hasChainlink && hasTWAP;
        }
        
        return hasChainlink || hasTWAP;
    }

    function getOracleSource(address token) external view returns (string memory) {
        OracleConfig storage config = tokenConfigs[token];
        
        if (!config.enabled) return "None";
        
        if (config.useChainlink && config.useTWAP) {
            return "Chainlink+TWAP";
        } else if (config.useChainlink) {
            return "Chainlink";
        } else if (config.useTWAP) {
            return "TWAP";
        }
        
        return "None";
    }

    function getTokenConfig(address token) external view returns (
        bool useChainlink,
        bool useTWAP,
        uint16 maxDeviationBps,
        bool requireBothSources,
        bool enabled
    ) {
        OracleConfig storage config = tokenConfigs[token];
        return (
            config.useChainlink,
            config.useTWAP,
            config.maxDeviationBps,
            config.requireBothSources,
            config.enabled
        );
    }

    function checkDeviation(address token) external view returns (
        uint256 chainlinkPrice,
        uint256 twapPrice,
        uint256 deviationBps,
        bool withinThreshold
    ) {
        OracleConfig storage config = tokenConfigs[token];
        
        if (chainlinkOracle != address(0)) {
            try IChainlinkOracle(chainlinkOracle).priceUsdE18(token) returns (uint256 p) {
                chainlinkPrice = p;
            } catch {}
        }
        
        if (twapOracle != address(0)) {
            try ITWAPOracle(twapOracle).priceUsdE18(token) returns (uint256 p) {
                twapPrice = p;
            } catch {}
        }
        
        if (chainlinkPrice > 0 && twapPrice > 0) {
            deviationBps = _calculateDeviation(chainlinkPrice, twapPrice);
            withinThreshold = deviationBps <= config.maxDeviationBps;
        }
    }
}
