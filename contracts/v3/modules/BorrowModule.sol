// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IProtocolCore {
    function owner() external view returns (address);
}

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

interface IMockSwapRouter {
    function priceUsdE18(address token) external view returns (uint256);
}

contract BorrowModule is Ownable {
    using SafeERC20 for IERC20;
    
    address public immutable protocolCore;
    address public swapRouter;
    
    struct BorrowPosition {
        uint256 principal;
        uint256 lastAccrualTime;
        uint256 aprBps;
    }
    
    mapping(address => mapping(address => BorrowPosition)) public positions;
    
    uint256 public defaultAprBps = 800;
    
    event Borrowed(address indexed vault, address indexed token, uint256 amount, uint256 aprBps);
    event Repaid(address indexed vault, address indexed token, uint256 amount);
    event AprUpdated(uint256 newAprBps);
    event RouterUpdated(address indexed newRouter);
    event LiquidityDeposited(address indexed token, uint256 amount);
    
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
    
    function borrow(
        address vault,
        address token,
        uint256 amount
    ) external onlyAuthorized(vault) {
        require(vault != address(0), "Invalid vault");
        require(token != address(0), "Invalid token");
        require(amount > 0, "Zero amount");
        
        uint256 available = IERC20(token).balanceOf(address(this));
        require(available >= amount, "Insufficient liquidity");
        
        BorrowPosition storage pos = positions[vault][token];
        
        if (pos.principal > 0) {
            uint256 accrued = _calculateAccrued(pos);
            pos.principal = accrued;
        }
        
        pos.principal += amount;
        pos.lastAccrualTime = block.timestamp;
        pos.aprBps = defaultAprBps;
        
        IERC20(token).safeTransfer(vault, amount);
        
        emit Borrowed(vault, token, amount, defaultAprBps);
    }
    
    function repay(
        address vault,
        address token,
        uint256 amount
    ) external onlyAuthorized(vault) returns (uint256 repaidAmount) {
        require(vault != address(0), "Invalid vault");
        require(token != address(0), "Invalid token");
        
        BorrowPosition storage pos = positions[vault][token];
        require(pos.principal > 0, "No position");
        
        uint256 accrued = _calculateAccrued(pos);
        
        if (amount == 0 || amount >= accrued) {
            repaidAmount = accrued;
            IERC20(token).safeTransferFrom(vault, address(this), repaidAmount);
            delete positions[vault][token];
        } else {
            repaidAmount = amount;
            IERC20(token).safeTransferFrom(vault, address(this), repaidAmount);
            pos.principal = accrued - amount;
            pos.lastAccrualTime = block.timestamp;
        }
        
        emit Repaid(vault, token, repaidAmount);
    }
    
    function getPositionValue(address vault, address token) external view returns (uint256) {
        BorrowPosition storage pos = positions[vault][token];
        if (pos.principal == 0) return 0;
        
        uint256 accrued = _calculateAccrued(pos);
        
        if (swapRouter != address(0)) {
            uint256 priceUsd = IMockSwapRouter(swapRouter).priceUsdE18(token);
            uint8 decimals = IERC20Metadata(token).decimals();
            return (accrued * priceUsd) / (10 ** decimals);
        }
        
        return accrued;
    }
    
    function getPosition(address vault, address token) external view returns (
        uint256 principal,
        uint256 accrued,
        uint256 aprBps,
        uint256 lastAccrualTime
    ) {
        BorrowPosition storage pos = positions[vault][token];
        principal = pos.principal;
        accrued = _calculateAccrued(pos);
        aprBps = pos.aprBps;
        lastAccrualTime = pos.lastAccrualTime;
    }
    
    function _calculateAccrued(BorrowPosition storage pos) internal view returns (uint256) {
        if (pos.principal == 0) return 0;
        
        uint256 elapsed = block.timestamp - pos.lastAccrualTime;
        uint256 interest = (pos.principal * pos.aprBps * elapsed) / (365 days * 10000);
        
        return pos.principal + interest;
    }
    
    function depositLiquidity(address token, uint256 amount) external {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Zero amount");
        
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        
        emit LiquidityDeposited(token, amount);
    }
    
    function setDefaultApr(uint256 _aprBps) external onlyOwner {
        require(_aprBps <= 10000, "APR too high");
        defaultAprBps = _aprBps;
        emit AprUpdated(_aprBps);
    }
    
    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid router");
        swapRouter = _router;
        emit RouterUpdated(_router);
    }
}
