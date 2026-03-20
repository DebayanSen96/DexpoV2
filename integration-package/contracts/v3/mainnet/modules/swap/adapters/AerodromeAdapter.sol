// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../ISwapAdapter.sol";

interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(
        uint256 amountIn,
        Route[] calldata routes
    ) external view returns (uint256[] memory amounts);
}

contract AerodromeAdapter is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;

    address public immutable router;
    address public immutable factory;
    address public swapHub;

    struct RouteConfig {
        bool stable;
        bool enabled;
    }

    mapping(address => mapping(address => RouteConfig)) public routes;

    event SwapHubUpdated(address indexed newHub);
    event RouteConfigured(address indexed tokenIn, address indexed tokenOut, bool stable, bool enabled);

    error OnlyHub();
    error RouteNotSupported();

    constructor(address _router, address _factory) Ownable(msg.sender) {
        router = _router;
        factory = _factory;
    }

    modifier onlyHub() {
        if (msg.sender != swapHub) revert OnlyHub();
        _;
    }

    function setSwapHub(address _hub) external onlyOwner {
        swapHub = _hub;
        emit SwapHubUpdated(_hub);
    }

    function configureRoute(address tokenIn, address tokenOut, bool stable, bool enabled) external onlyOwner {
        routes[tokenIn][tokenOut] = RouteConfig({stable: stable, enabled: enabled});
        emit RouteConfigured(tokenIn, tokenOut, stable, enabled);
    }

    function protocolName() external pure override returns (string memory) {
        return "Aerodrome";
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external override onlyHub returns (uint256 amountOut) {
        RouteConfig storage config = routes[tokenIn][tokenOut];
        if (!config.enabled) revert RouteNotSupported();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(router, amountIn);

        IAerodromeRouter.Route[] memory routePath = new IAerodromeRouter.Route[](1);
        routePath[0] = IAerodromeRouter.Route({
            from: tokenIn,
            to: tokenOut,
            stable: config.stable,
            factory: factory
        });

        uint256[] memory amounts = IAerodromeRouter(router).swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            routePath,
            recipient,
            block.timestamp
        );

        amountOut = amounts[amounts.length - 1];
    }

    function getQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view override returns (uint256 amountOut) {
        RouteConfig storage config = routes[tokenIn][tokenOut];
        if (!config.enabled) return 0;

        IAerodromeRouter.Route[] memory routePath = new IAerodromeRouter.Route[](1);
        routePath[0] = IAerodromeRouter.Route({
            from: tokenIn,
            to: tokenOut,
            stable: config.stable,
            factory: factory
        });

        uint256[] memory amounts = IAerodromeRouter(router).getAmountsOut(amountIn, routePath);
        amountOut = amounts[amounts.length - 1];
    }

    function isRouteSupported(address tokenIn, address tokenOut) external view override returns (bool) {
        return routes[tokenIn][tokenOut].enabled;
    }
}
