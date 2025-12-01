// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IProtocolCore {
    function owner() external view returns (address);
}

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

interface IMockSwapRouter {
    function swapFrom(address tokenIn, address tokenOut, uint256 amountIn, address from, address recipient) external returns (uint256 amountOut);
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
}

contract BuySellModule is Ownable {
    using SafeERC20 for IERC20;
    
    address public immutable protocolCore;
    address public swapRouter;
    
    mapping(address => mapping(address => uint256)) public vaultBuyVolume;
    mapping(address => mapping(address => uint256)) public vaultSellVolume;
    
    event TokenBought(address indexed vault, address indexed token, uint256 amountIn, uint256 amountOut);
    event TokenSold(address indexed vault, address indexed token, uint256 amountIn, uint256 amountOut);
    event RouterUpdated(address indexed newRouter);
    
    constructor(address _protocolCore, address _swapRouter) Ownable(msg.sender) {
        require(_protocolCore != address(0), "Invalid core");
        require(_swapRouter != address(0), "Invalid router");
        protocolCore = _protocolCore;
        swapRouter = _swapRouter;
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
        
        require(isSafeOwner || isProtocolOwner, "Not authorized");
        _;
    }
    
    function buyToken(
        address vault,
        address baseToken,
        address tokenToBuy,
        uint256 amountBase
    ) external onlyAuthorized(vault) returns (uint256 amountOut) {
        require(vault != address(0), "Invalid vault");
        require(baseToken != address(0) && tokenToBuy != address(0), "Invalid tokens");
        require(amountBase > 0, "Zero amount");
        
        IERC20(baseToken).safeTransferFrom(vault, address(this), amountBase);
        
        IERC20(baseToken).forceApprove(swapRouter, amountBase);
        amountOut = IMockSwapRouter(swapRouter).swapFrom(baseToken, tokenToBuy, amountBase, address(this), vault);
        
        vaultBuyVolume[vault][tokenToBuy] += amountOut;
        
        emit TokenBought(vault, tokenToBuy, amountBase, amountOut);
    }
    
    function sellToken(
        address vault,
        address tokenToSell,
        address baseToken,
        uint256 amountToken
    ) external onlyAuthorized(vault) returns (uint256 amountOut) {
        require(vault != address(0), "Invalid vault");
        require(tokenToSell != address(0) && baseToken != address(0), "Invalid tokens");
        require(amountToken > 0, "Zero amount");
        
        IERC20(tokenToSell).safeTransferFrom(vault, address(this), amountToken);
        
        IERC20(tokenToSell).forceApprove(swapRouter, amountToken);
        amountOut = IMockSwapRouter(swapRouter).swapFrom(tokenToSell, baseToken, amountToken, address(this), vault);
        
        vaultSellVolume[vault][tokenToSell] += amountToken;
        
        emit TokenSold(vault, tokenToSell, amountToken, amountOut);
    }
    
    function quoteBuy(address baseToken, address tokenToBuy, uint256 amountBase) external view returns (uint256) {
        return IMockSwapRouter(swapRouter).quote(baseToken, tokenToBuy, amountBase);
    }
    
    function quoteSell(address tokenToSell, address baseToken, uint256 amountToken) external view returns (uint256) {
        return IMockSwapRouter(swapRouter).quote(tokenToSell, baseToken, amountToken);
    }
    
    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid router");
        swapRouter = _router;
        emit RouterUpdated(_router);
    }
    
    function getVaultBuyVolume(address vault, address token) external view returns (uint256) {
        return vaultBuyVolume[vault][token];
    }
    
    function getVaultSellVolume(address vault, address token) external view returns (uint256) {
        return vaultSellVolume[vault][token];
    }
}
