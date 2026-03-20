// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../mainnet/modules/swap/ISwapAdapter.sol";

interface IMockSwapRouter {
    function isSupportedToken(address token) external view returns (bool);
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient) external returns (uint256 amountOut);
}

contract MockSwapAdapter is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;

    address public immutable router;
    address public swapHub;

    error OnlyHub();

    constructor(address _router) Ownable(msg.sender) {
        router = _router;
    }

    modifier onlyHub() {
        if (msg.sender != swapHub) revert OnlyHub();
        _;
    }

    function setSwapHub(address _hub) external onlyOwner {
        swapHub = _hub;
    }

    function protocolName() external pure override returns (string memory) {
        return "Mock Swap";
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external override onlyHub returns (uint256 amountOut) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(router, amountIn);
        amountOut = IMockSwapRouter(router).swap(tokenIn, tokenOut, amountIn, recipient);
        require(amountOut >= minAmountOut, "Insufficient output");
    }

    function getQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view override returns (uint256 amountOut) {
        return IMockSwapRouter(router).quote(tokenIn, tokenOut, amountIn);
    }

    function isRouteSupported(address tokenIn, address tokenOut) external view override returns (bool) {
        return IMockSwapRouter(router).isSupportedToken(tokenIn) && IMockSwapRouter(router).isSupportedToken(tokenOut) && tokenIn != tokenOut;
    }
}
