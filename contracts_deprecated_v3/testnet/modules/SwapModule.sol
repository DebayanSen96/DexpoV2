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

contract SwapModule is Ownable {
    using SafeERC20 for IERC20;
    
    address public immutable protocolCore;
    address public swapRouter;
    
    mapping(address => mapping(address => mapping(address => uint256))) public vaultSwapVolume;
    
    event Swapped(address indexed vault, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
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
    
    function swap(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external onlyAuthorized(vault) returns (uint256 amountOut) {
        require(vault != address(0), "Invalid vault");
        require(tokenIn != address(0) && tokenOut != address(0), "Invalid tokens");
        require(amountIn > 0, "Zero amount");
        
        IERC20(tokenIn).safeTransferFrom(vault, address(this), amountIn);
        
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);
        amountOut = IMockSwapRouter(swapRouter).swapFrom(tokenIn, tokenOut, amountIn, address(this), vault);
        
        vaultSwapVolume[vault][tokenIn][tokenOut] += amountIn;
        
        emit Swapped(vault, tokenIn, tokenOut, amountIn, amountOut);
    }
    
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        return IMockSwapRouter(swapRouter).quote(tokenIn, tokenOut, amountIn);
    }
    
    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid router");
        swapRouter = _router;
        emit RouterUpdated(_router);
    }
    
    function getVaultSwapVolume(address vault, address tokenIn, address tokenOut) external view returns (uint256) {
        return vaultSwapVolume[vault][tokenIn][tokenOut];
    }
}
