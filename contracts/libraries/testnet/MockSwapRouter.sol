// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockSwapRouter
 * @notice A simple price-based swap emulator. It holds balances of multiple ERC20 tokens
 *         and allows swapping between them using owner-settable USD prices. Useful for
 *         testnets where you want deterministic quotes without AMM math.
 *
 * Price model:
 *  - Each token has a price in USD scaled by 1e18 (USD with 18 decimals per 1 whole token).
 *  - Example: priceUSDC = 1e18, priceWETH = 2500e18, priceDXP = 0.2e18
 *
 * Quote/out math:
 *  - valueUSD = amountIn (in tokenIn native decimals) * priceIn / 10**decimals(tokenIn)
 *  - amountOut = valueUSD * 10**decimals(tokenOut) / priceOut
 */
contract MockSwapRouter is Ownable {
    using SafeERC20 for IERC20;

    // token => price in USD (1e18)
    mapping(address => uint256) public priceUsdE18;
    // token => decimals cached for gas
    mapping(address => uint8) public tokenDecimals;
    // track if token supported for convenience checks (optional)
    mapping(address => bool) public isSupportedToken;
    address[] public tokens;

    event PriceUpdated(address indexed token, uint256 priceUsdE18);
    event PricesUpdated(address[] tokens, uint256[] prices);
    event TokenAdded(address indexed token, uint8 decimals, uint256 priceUsdE18);
    event Swap(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient);

    error UnsupportedToken(address token);
    error InsufficientLiquidity(address tokenOut);
    error InvalidArrayLength();

    constructor(address _owner, address[] memory _tokens, uint256[] memory _pricesUsdE18) Ownable(_owner) {
        if (_tokens.length != _pricesUsdE18.length) revert InvalidArrayLength();
        for (uint256 i = 0; i < _tokens.length; i++) {
            _addOrUpdateToken(_tokens[i], _pricesUsdE18[i]);
        }
    }

    // ------------------------ Owner functions ------------------------

    function setPrice(address token, uint256 price) external onlyOwner {
        if (!isSupportedToken[token]) revert UnsupportedToken(token);
        priceUsdE18[token] = price;
        emit PriceUpdated(token, price);
    }

    function setPrices(address[] calldata _tokens, uint256[] calldata _prices) external onlyOwner {
        if (_tokens.length != _prices.length) revert InvalidArrayLength();
        for (uint256 i = 0; i < _tokens.length; i++) {
            if (!isSupportedToken[_tokens[i]]) revert UnsupportedToken(_tokens[i]);
            priceUsdE18[_tokens[i]] = _prices[i];
        }
        emit PricesUpdated(_tokens, _prices);
    }

    function addOrUpdateToken(address token, uint256 price) external onlyOwner {
        _addOrUpdateToken(token, price);
    }

    function _addOrUpdateToken(address token, uint256 price) internal {
        uint8 dec = _getDecimals(token);
        if (!isSupportedToken[token]) {
            isSupportedToken[token] = true;
            tokens.push(token);
            tokenDecimals[token] = dec;
        } else if (tokenDecimals[token] != dec) {
            tokenDecimals[token] = dec; // refresh if changed
        }
        priceUsdE18[token] = price;
        emit TokenAdded(token, dec, price);
    }

    // ------------------------ View functions ------------------------

    function getTokens() external view returns (address[] memory) {
        return tokens;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256 amountOut) {
        if (!isSupportedToken[tokenIn]) revert UnsupportedToken(tokenIn);
        if (!isSupportedToken[tokenOut]) revert UnsupportedToken(tokenOut);
        uint256 pIn = priceUsdE18[tokenIn];
        uint256 pOut = priceUsdE18[tokenOut];
        require(pIn > 0 && pOut > 0, "price=0");
        uint8 dIn = tokenDecimals[tokenIn];
        uint8 dOut = tokenDecimals[tokenOut];
        // valueUSD = amountIn * pIn / 10**dIn
        uint256 valueUsd = (amountIn * pIn) / (10 ** dIn);
        // amountOut = valueUsd * 10**dOut / pOut
        amountOut = (valueUsd * (10 ** dOut)) / pOut;
    }

    // ------------------------ Swap ------------------------
    
    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient) external returns (uint256 amountOut) {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        // pull tokens in
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        // ensure liquidity
        uint256 balOut = IERC20(tokenOut).balanceOf(address(this));
        if (balOut < amountOut) revert InsufficientLiquidity(tokenOut);
        // send out
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    /**
     * @notice Pull tokens from a specified address `from` (who must have approved the router),
     *         then send the output tokens to `recipient`.
     */
    function swapFrom(address tokenIn, address tokenOut, uint256 amountIn, address from, address recipient) external returns (uint256 amountOut) {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        // pull tokens from `from` (spender is this router)
        IERC20(tokenIn).safeTransferFrom(from, address(this), amountIn);
        // ensure liquidity
        uint256 balOut = IERC20(tokenOut).balanceOf(address(this));
        if (balOut < amountOut) revert InsufficientLiquidity(tokenOut);
        // send out to recipient
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swap(from, tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    // ------------------------ Helpers ------------------------

    function _getDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 dec) {
            return dec;
        } catch {
            return 18;
        }
    }
}
