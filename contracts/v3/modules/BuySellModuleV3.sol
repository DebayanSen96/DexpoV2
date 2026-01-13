// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/ISwapRouter.sol";
import "../interfaces/IOracle.sol";

interface IProtocolCore {
    function owner() external view returns (address);
}

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

contract BuySellModuleV3 is Ownable {
    using SafeERC20 for IERC20;
    
    address public immutable protocolCore;
    address public swapRouter;
    address public oracle;
    
    uint24 public defaultPoolFee = 3000;
    uint256 public maxSlippageBps = 100;
    
    mapping(address => mapping(address => uint24)) public pairPoolFee;
    mapping(address => mapping(address => uint256)) public vaultBuyVolume;
    mapping(address => mapping(address => uint256)) public vaultSellVolume;
    
    event TokenBought(address indexed vault, address indexed token, uint256 amountIn, uint256 amountOut);
    event TokenSold(address indexed vault, address indexed token, uint256 amountIn, uint256 amountOut);
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
    
    function buyToken(
        address vault,
        address baseToken,
        address tokenToBuy,
        uint256 amountBase
    ) external onlyAuthorized(vault) returns (uint256 amountOut) {
        return buyTokenWithSlippage(vault, baseToken, tokenToBuy, amountBase, maxSlippageBps);
    }
    
    function buyTokenWithSlippage(
        address vault,
        address baseToken,
        address tokenToBuy,
        uint256 amountBase,
        uint256 slippageBps
    ) public onlyAuthorized(vault) returns (uint256 amountOut) {
        require(vault != address(0), "Invalid vault");
        require(baseToken != address(0) && tokenToBuy != address(0), "Invalid tokens");
        if (amountBase == 0) revert ZeroAmount();
        
        IERC20(baseToken).safeTransferFrom(vault, address(this), amountBase);
        IERC20(baseToken).forceApprove(swapRouter, amountBase);
        
        uint256 amountOutMin = _calculateMinOutput(baseToken, tokenToBuy, amountBase, slippageBps);
        
        uint24 fee = _getPoolFee(baseToken, tokenToBuy);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: baseToken,
            tokenOut: tokenToBuy,
            fee: fee,
            recipient: vault,
            amountIn: amountBase,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        
        amountOut = ISwapRouter(swapRouter).exactInputSingle(params);
        
        vaultBuyVolume[vault][tokenToBuy] += amountOut;
        
        emit TokenBought(vault, tokenToBuy, amountBase, amountOut);
    }
    
    function sellToken(
        address vault,
        address tokenToSell,
        address baseToken,
        uint256 amountToken
    ) external onlyAuthorized(vault) returns (uint256 amountOut) {
        return sellTokenWithSlippage(vault, tokenToSell, baseToken, amountToken, maxSlippageBps);
    }
    
    function sellTokenWithSlippage(
        address vault,
        address tokenToSell,
        address baseToken,
        uint256 amountToken,
        uint256 slippageBps
    ) public onlyAuthorized(vault) returns (uint256 amountOut) {
        require(vault != address(0), "Invalid vault");
        require(tokenToSell != address(0) && baseToken != address(0), "Invalid tokens");
        if (amountToken == 0) revert ZeroAmount();
        
        IERC20(tokenToSell).safeTransferFrom(vault, address(this), amountToken);
        IERC20(tokenToSell).forceApprove(swapRouter, amountToken);
        
        uint256 amountOutMin = _calculateMinOutput(tokenToSell, baseToken, amountToken, slippageBps);
        
        uint24 fee = _getPoolFee(tokenToSell, baseToken);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenToSell,
            tokenOut: baseToken,
            fee: fee,
            recipient: vault,
            amountIn: amountToken,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        
        amountOut = ISwapRouter(swapRouter).exactInputSingle(params);
        
        vaultSellVolume[vault][tokenToSell] += amountToken;
        
        emit TokenSold(vault, tokenToSell, amountToken, amountOut);
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
    
    function quoteBuy(address baseToken, address tokenToBuy, uint256 amountBase) external view returns (uint256) {
        uint256 priceIn = IOracle(oracle).priceUsdE18(baseToken);
        uint256 priceOut = IOracle(oracle).priceUsdE18(tokenToBuy);
        if (priceIn == 0 || priceOut == 0) return 0;
        return (amountBase * priceIn) / priceOut;
    }
    
    function quoteSell(address tokenToSell, address baseToken, uint256 amountToken) external view returns (uint256) {
        uint256 priceIn = IOracle(oracle).priceUsdE18(tokenToSell);
        uint256 priceOut = IOracle(oracle).priceUsdE18(baseToken);
        if (priceIn == 0 || priceOut == 0) return 0;
        return (amountToken * priceIn) / priceOut;
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
    
    function getVaultBuyVolume(address vault, address token) external view returns (uint256) {
        return vaultBuyVolume[vault][token];
    }
    
    function getVaultSellVolume(address vault, address token) external view returns (uint256) {
        return vaultSellVolume[vault][token];
    }
}
