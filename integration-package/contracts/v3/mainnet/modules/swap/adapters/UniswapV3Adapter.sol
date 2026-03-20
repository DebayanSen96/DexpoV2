// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../ISwapAdapter.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}

contract UniswapV3Adapter is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;

    address public immutable swapRouter;
    address public immutable quoter;
    address public swapHub;

    struct PoolConfig {
        uint24 fee;
        bool enabled;
    }

    mapping(address => mapping(address => PoolConfig)) public pools;

    event SwapHubUpdated(address indexed newHub);
    event PoolConfigured(address indexed tokenIn, address indexed tokenOut, uint24 fee, bool enabled);

    error OnlyHub();
    error PoolNotConfigured();

    constructor(address _swapRouter, address _quoter) Ownable(msg.sender) {
        swapRouter = _swapRouter;
        quoter = _quoter;
    }

    modifier onlyHub() {
        if (msg.sender != swapHub) revert OnlyHub();
        _;
    }

    function setSwapHub(address _hub) external onlyOwner {
        swapHub = _hub;
        emit SwapHubUpdated(_hub);
    }

    function configurePool(address tokenIn, address tokenOut, uint24 fee, bool enabled) external onlyOwner {
        pools[tokenIn][tokenOut] = PoolConfig({fee: fee, enabled: enabled});
        emit PoolConfigured(tokenIn, tokenOut, fee, enabled);
    }

    function protocolName() external pure override returns (string memory) {
        return "Uniswap V3";
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external override onlyHub returns (uint256 amountOut) {
        PoolConfig storage config = pools[tokenIn][tokenOut];
        if (!config.enabled) revert PoolNotConfigured();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);

        ISwapRouter02.ExactInputSingleParams memory params = ISwapRouter02.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: config.fee,
            recipient: recipient,
            amountIn: amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = ISwapRouter02(swapRouter).exactInputSingle(params);
    }

    function getQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view override returns (uint256 amountOut) {
        PoolConfig storage config = pools[tokenIn][tokenOut];
        if (!config.enabled) return 0;

        bytes memory data = abi.encodeWithSelector(
            IQuoterV2.quoteExactInputSingle.selector,
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                fee: config.fee,
                sqrtPriceLimitX96: 0
            })
        );

        (bool success, bytes memory result) = quoter.staticcall(data);
        if (!success || result.length < 32) return 0;

        (amountOut,,,) = abi.decode(result, (uint256, uint160, uint32, uint256));
    }

    function isRouteSupported(address tokenIn, address tokenOut) external view override returns (bool) {
        return pools[tokenIn][tokenOut].enabled;
    }
}
