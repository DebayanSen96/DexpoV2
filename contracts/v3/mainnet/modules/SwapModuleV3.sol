// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/ISwapRouter.sol";
import "../../interfaces/IOracle.sol";

interface IProtocolCore {
    function owner() external view returns (address);
}

interface IFeeCollector {
    function collectFee(address vault, address token, uint256 amount) external;
}

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

contract SwapModuleV3 is Ownable {
    using SafeERC20 for IERC20;
    
    address public immutable protocolCore;
    address public swapRouter;
    address public oracle;
    
    uint24 public defaultPoolFee = 3000;
    uint256 public maxSlippageBps = 100;
    
    mapping(address => mapping(address => uint24)) public pairPoolFee;
    mapping(address => mapping(address => mapping(address => uint256))) public vaultSwapVolume;
    
    event Swapped(address indexed vault, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event RouterUpdated(address indexed newRouter);
    event OracleUpdated(address indexed newOracle);
    event PoolFeeSet(address indexed tokenA, address indexed tokenB, uint24 fee);
    event DefaultPoolFeeSet(uint24 fee);
    event MaxSlippageSet(uint256 bps);
    
    error NotAuthorized();
    error ZeroAmount();
    error SlippageExceeded(uint256 expected, uint256 received);
    
    constructor(address _protocolCore, address _swapRouter, address _oracle) Ownable(msg.sender) {
        require(_protocolCore != address(0), "Invalid core");
        require(_swapRouter != address(0), "Invalid router");
        require(_oracle != address(0), "Invalid oracle");
        protocolCore = _protocolCore;
        swapRouter = _swapRouter;
        oracle = _oracle;
    }
    
    modifier onlyAuthorized(address vault) {
        bool isSafeOwner = false;
        bool isProtocolOwner = false;
        
        try IVaultSafe(vault).isOwner(msg.sender) returns (bool result) {
            isSafeOwner = result;
        } catch {}
        
        try IProtocolCore(protocolCore).owner() returns (address po) {
            isProtocolOwner = (msg.sender == po);
        } catch {}
        
        if (!isSafeOwner && !isProtocolOwner) revert NotAuthorized();
        _;
    }
    
    function swap(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external onlyAuthorized(vault) returns (uint256 amountOut) {
        return swapWithSlippage(vault, tokenIn, tokenOut, amountIn, maxSlippageBps);
    }
    
    function swapWithSlippage(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageBps
    ) public onlyAuthorized(vault) returns (uint256 amountOut) {
        require(vault != address(0), "Invalid vault");
        require(tokenIn != address(0) && tokenOut != address(0), "Invalid tokens");
        if (amountIn == 0) revert ZeroAmount();
        
        IERC20(tokenIn).safeTransferFrom(vault, address(this), amountIn);
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);
        
        uint256 amountOutMin = _calculateMinOutput(tokenIn, tokenOut, amountIn, slippageBps);
        
        uint24 fee = _getPoolFee(tokenIn, tokenOut);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: vault,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        
        amountOut = ISwapRouter(swapRouter).exactInputSingle(params);
        
        vaultSwapVolume[vault][tokenIn][tokenOut] += amountIn;
        
        emit Swapped(vault, tokenIn, tokenOut, amountIn, amountOut);
    }
    
    function swapMultiHop(
        address vault,
        bytes calldata path,
        uint256 amountIn,
        uint256 amountOutMin
    ) external onlyAuthorized(vault) returns (uint256 amountOut) {
        require(vault != address(0), "Invalid vault");
        if (amountIn == 0) revert ZeroAmount();
        
        address tokenIn = _extractFirstToken(path);
        
        IERC20(tokenIn).safeTransferFrom(vault, address(this), amountIn);
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);
        
        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: path,
            recipient: vault,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin
        });
        
        amountOut = ISwapRouter(swapRouter).exactInput(params);
    }
    
    function _calculateMinOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageBps
    ) internal view returns (uint256) {
        uint256 priceIn = IOracle(oracle).priceUsdE18(tokenIn);
        uint256 priceOut = IOracle(oracle).priceUsdE18(tokenOut);
        
        if (priceIn == 0 || priceOut == 0) return 0;
        
        uint256 expectedOut = (amountIn * priceIn) / priceOut;
        uint256 minOut = (expectedOut * (10000 - slippageBps)) / 10000;
        
        return minOut;
    }
    
    function _getPoolFee(address tokenA, address tokenB) internal view returns (uint24) {
        uint24 fee = pairPoolFee[tokenA][tokenB];
        if (fee == 0) fee = pairPoolFee[tokenB][tokenA];
        if (fee == 0) fee = defaultPoolFee;
        return fee;
    }
    
    function _extractFirstToken(bytes calldata path) internal pure returns (address) {
        require(path.length >= 20, "Invalid path");
        address token;
        assembly {
            token := shr(96, calldataload(path.offset))
        }
        return token;
    }
    
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        uint256 priceIn = IOracle(oracle).priceUsdE18(tokenIn);
        uint256 priceOut = IOracle(oracle).priceUsdE18(tokenOut);
        if (priceIn == 0 || priceOut == 0) return 0;
        return (amountIn * priceIn) / priceOut;
    }
    
    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid router");
        swapRouter = _router;
        emit RouterUpdated(_router);
    }
    
    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }
    
    function setPoolFee(address tokenA, address tokenB, uint24 fee) external onlyOwner {
        pairPoolFee[tokenA][tokenB] = fee;
        emit PoolFeeSet(tokenA, tokenB, fee);
    }
    
    function setDefaultPoolFee(uint24 fee) external onlyOwner {
        defaultPoolFee = fee;
        emit DefaultPoolFeeSet(fee);
    }
    
    function setMaxSlippage(uint256 bps) external onlyOwner {
        require(bps <= 1000, "Slippage too high");
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }
    
    function getVaultSwapVolume(address vault, address tokenIn, address tokenOut) external view returns (uint256) {
        return vaultSwapVolume[vault][tokenIn][tokenOut];
    }
}
