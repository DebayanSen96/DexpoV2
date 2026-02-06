// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/IOracle.sol";

interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

contract UniswapV3TWAPOracle is IOracle, Ownable {
    
    struct PoolConfig {
        address pool;
        address quoteToken;
        bool isToken0;
        bool enabled;
    }
    
    mapping(address => PoolConfig) public tokenPools;
    
    address public weth;
    address public usdc;
    address public chainlinkEthUsdFeed;
    
    uint32 public twapWindow = 1800; // 30 minutes default
    uint16 public minCardinality = 100;
    uint128 public minLiquidity = 1e15; // Minimum pool liquidity
    
    event PoolConfigured(address indexed token, address indexed pool, address quoteToken, bool isToken0);
    event PoolDisabled(address indexed token);
    event TWAPWindowUpdated(uint32 oldWindow, uint32 newWindow);
    event MinCardinalityUpdated(uint16 oldMin, uint16 newMin);
    event MinLiquidityUpdated(uint128 oldMin, uint128 newMin);
    
    error PoolNotConfigured(address token);
    error InsufficientCardinality(address pool, uint16 current, uint16 required);
    error InsufficientLiquidity(address pool, uint128 current, uint128 required);
    error StaleObservation(address pool);
    error InvalidPrice();
    error ZeroAddress();

    constructor(
        address _weth,
        address _usdc,
        address _chainlinkEthUsdFeed
    ) Ownable(msg.sender) {
        if (_weth == address(0) || _usdc == address(0)) revert ZeroAddress();
        weth = _weth;
        usdc = _usdc;
        chainlinkEthUsdFeed = _chainlinkEthUsdFeed;
    }

    function configurePool(
        address token,
        address pool,
        address quoteToken
    ) external onlyOwner {
        if (token == address(0) || pool == address(0)) revert ZeroAddress();
        
        IUniswapV3Pool uniPool = IUniswapV3Pool(pool);
        address token0 = uniPool.token0();
        address token1 = uniPool.token1();
        
        bool isToken0 = (token == token0);
        require(isToken0 || token == token1, "Token not in pool");
        require(quoteToken == (isToken0 ? token1 : token0), "Invalid quote token");
        
        tokenPools[token] = PoolConfig({
            pool: pool,
            quoteToken: quoteToken,
            isToken0: isToken0,
            enabled: true
        });
        
        emit PoolConfigured(token, pool, quoteToken, isToken0);
    }

    function disablePool(address token) external onlyOwner {
        tokenPools[token].enabled = false;
        emit PoolDisabled(token);
    }

    function setTWAPWindow(uint32 _twapWindow) external onlyOwner {
        require(_twapWindow >= 300, "Window too short"); // Min 5 minutes
        require(_twapWindow <= 7200, "Window too long"); // Max 2 hours
        uint32 old = twapWindow;
        twapWindow = _twapWindow;
        emit TWAPWindowUpdated(old, _twapWindow);
    }

    function setMinCardinality(uint16 _minCardinality) external onlyOwner {
        require(_minCardinality >= 10, "Cardinality too low");
        uint16 old = minCardinality;
        minCardinality = _minCardinality;
        emit MinCardinalityUpdated(old, _minCardinality);
    }

    function setMinLiquidity(uint128 _minLiquidity) external onlyOwner {
        uint128 old = minLiquidity;
        minLiquidity = _minLiquidity;
        emit MinLiquidityUpdated(old, _minLiquidity);
    }

    function priceUsdE18(address token) external view override returns (uint256) {
        if (token == weth) {
            return _getEthPriceUsd();
        }
        
        PoolConfig storage config = tokenPools[token];
        if (!config.enabled || config.pool == address(0)) revert PoolNotConfigured(token);
        
        _validatePool(config.pool);
        
        uint256 twapPrice = _getTWAP(config.pool, config.isToken0);
        
        if (config.quoteToken == weth) {
            uint256 ethPriceUsd = _getEthPriceUsd();
            uint8 tokenDecimals = IERC20Decimals(token).decimals();
            uint8 wethDecimals = 18;
            
            // twapPrice is in quote token (WETH) per base token
            // Convert to USD: twapPrice * ethPriceUsd
            // Normalize to 18 decimals
            return _normalizePrice(twapPrice, ethPriceUsd, tokenDecimals, wethDecimals);
        } else if (config.quoteToken == usdc) {
            uint8 tokenDecimals = IERC20Decimals(token).decimals();
            uint8 usdcDecimals = 6;
            
            // twapPrice is in USDC per token, scale to 18 decimals
            return _normalizePriceUsdc(twapPrice, tokenDecimals, usdcDecimals);
        }
        
        revert InvalidPrice();
    }

    function getPrice(address token) external view override returns (uint256 price, uint8 decimals) {
        price = this.priceUsdE18(token);
        decimals = 18;
    }

    function getTWAP(address token) external view returns (uint256) {
        PoolConfig storage config = tokenPools[token];
        if (!config.enabled || config.pool == address(0)) revert PoolNotConfigured(token);
        
        _validatePool(config.pool);
        return _getTWAP(config.pool, config.isToken0);
    }

    function _getTWAP(address pool, bool isToken0) internal view returns (uint256) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        
        (int56[] memory tickCumulatives,) = IUniswapV3Pool(pool).observe(secondsAgos);
        
        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 arithmeticMeanTick = int24(tickCumulativesDelta / int56(uint56(twapWindow)));
        
        if (tickCumulativesDelta < 0 && (tickCumulativesDelta % int56(uint56(twapWindow)) != 0)) {
            arithmeticMeanTick--;
        }
        
        uint160 sqrtPriceX96 = _getSqrtRatioAtTick(arithmeticMeanTick);
        
        // Calculate price from sqrtPriceX96
        // price = (sqrtPriceX96 / 2^96)^2 = sqrtPriceX96^2 / 2^192
        uint256 priceX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        
        if (isToken0) {
            // Price of token0 in terms of token1
            // price = priceX192 / 2^192, scaled by 1e18
            return (priceX192 * 1e18) >> 192;
        } else {
            // Price of token1 in terms of token0
            // price = 2^192 / priceX192, scaled by 1e18
            return (uint256(1) << 192) * 1e18 / priceX192;
        }
    }

    function _validatePool(address pool) internal view {
        IUniswapV3Pool uniPool = IUniswapV3Pool(pool);
        
        (,,, uint16 observationCardinality,,,) = uniPool.slot0();
        
        if (observationCardinality < minCardinality) {
            revert InsufficientCardinality(pool, observationCardinality, minCardinality);
        }
        
        uint128 liquidity = uniPool.liquidity();
        if (liquidity < minLiquidity) {
            revert InsufficientLiquidity(pool, liquidity, minLiquidity);
        }
    }

    function _getEthPriceUsd() internal view returns (uint256) {
        if (chainlinkEthUsdFeed == address(0)) revert InvalidPrice();
        
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(chainlinkEthUsdFeed).latestRoundData();
        
        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > 1 hours) revert StaleObservation(chainlinkEthUsdFeed);
        
        uint8 feedDecimals = AggregatorV3Interface(chainlinkEthUsdFeed).decimals();
        
        if (feedDecimals == 18) return uint256(answer);
        if (feedDecimals < 18) return uint256(answer) * (10 ** (18 - feedDecimals));
        return uint256(answer) / (10 ** (feedDecimals - 18));
    }

    function _normalizePrice(
        uint256 twapPrice,
        uint256 ethPriceUsd,
        uint8 tokenDecimals,
        uint8 /* quoteDecimals */
    ) internal pure returns (uint256) {
        // twapPrice is token price in WETH (scaled by 1e18 from _getTWAP)
        // ethPriceUsd is ETH price in USD (scaled by 1e18)
        // Result should be token price in USD (scaled by 1e18)
        
        // price_usd = twapPrice * ethPriceUsd / 1e18
        // Adjust for decimal differences
        uint256 priceUsd = (twapPrice * ethPriceUsd) / 1e18;
        
        // Adjust for token decimals if needed
        if (tokenDecimals < 18) {
            priceUsd = priceUsd * (10 ** (18 - tokenDecimals));
        } else if (tokenDecimals > 18) {
            priceUsd = priceUsd / (10 ** (tokenDecimals - 18));
        }
        
        return priceUsd;
    }

    function _normalizePriceUsdc(
        uint256 twapPrice,
        uint8 tokenDecimals,
        uint8 usdcDecimals
    ) internal pure returns (uint256) {
        // twapPrice is token price in USDC (scaled by 1e18 from _getTWAP)
        // USDC has 6 decimals, so we need to scale up to 18
        
        // Scale USDC price to 18 decimals
        uint256 priceUsd = twapPrice * (10 ** (18 - usdcDecimals));
        
        // Adjust for token decimals
        if (tokenDecimals < 18) {
            priceUsd = priceUsd * (10 ** (18 - tokenDecimals));
        } else if (tokenDecimals > 18) {
            priceUsd = priceUsd / (10 ** (tokenDecimals - 18));
        }
        
        return priceUsd;
    }

    function _getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= uint256(int256(887272)), "T");

        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) ratio = type(uint256).max / ratio;

        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    function hasPriceFeed(address token) external view returns (bool) {
        if (token == weth) return true;
        PoolConfig storage config = tokenPools[token];
        return config.enabled && config.pool != address(0);
    }

    function getPoolConfig(address token) external view returns (
        address pool,
        address quoteToken,
        bool isToken0,
        bool enabled
    ) {
        PoolConfig storage config = tokenPools[token];
        return (config.pool, config.quoteToken, config.isToken0, config.enabled);
    }

    function validatePoolHealth(address token) external view returns (
        bool isHealthy,
        uint16 cardinality,
        uint128 liquidity
    ) {
        PoolConfig storage config = tokenPools[token];
        if (!config.enabled || config.pool == address(0)) {
            return (false, 0, 0);
        }
        
        IUniswapV3Pool uniPool = IUniswapV3Pool(config.pool);
        (,,, uint16 observationCardinality,,,) = uniPool.slot0();
        uint128 poolLiquidity = uniPool.liquidity();
        
        isHealthy = observationCardinality >= minCardinality && poolLiquidity >= minLiquidity;
        cardinality = observationCardinality;
        liquidity = poolLiquidity;
    }
}

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}
