// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ISwapAdapter.sol";

interface IProtocolCore {
    function owner() external view returns (address);
}

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

interface IIndexSwap {
    function safe() external view returns (address);
}

interface IOracle {
    function priceUsdE18(address token) external view returns (uint256);
}

contract SwapHub is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable protocolCore;
    address public oracle;
    uint256 public defaultSlippageBps = 100;
    uint256 public constant MAX_ADAPTERS_TO_CHECK = 10;

    struct AdapterInfo {
        address adapterAddress;
        bool active;
        string name;
    }

    mapping(bytes32 => AdapterInfo) public adapters;
    bytes32[] public adapterIds;
    bytes32 public defaultAdapterId;

    event AdapterAdded(bytes32 indexed adapterId, address indexed adapter, string name);
    event AdapterRemoved(bytes32 indexed adapterId);
    event AdapterUpdated(bytes32 indexed adapterId, address indexed newAdapter);
    event DefaultAdapterSet(bytes32 indexed adapterId);
    event Swapped(address indexed vault, bytes32 indexed adapterId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    error NotAuthorized();
    error AdapterNotFound();
    error AdapterNotActive();
    error RouteNotSupported();
    error ZeroAmount();
    error SlippageExceeded();
    error SwapExpired();
    error InsufficientOutput();

    constructor(address _protocolCore, address _oracle) Ownable(msg.sender) {
        protocolCore = _protocolCore;
        oracle = _oracle;
    }

    modifier onlyAuthorized(address vault) {
        bool isVaultItself = (msg.sender == vault);
        bool isSafeOwner = false;
        bool isProtocolOwner = false;

        if (!isVaultItself) {
            address safeAddress = IIndexSwap(vault).safe();
            isSafeOwner = (msg.sender == safeAddress);
            if (!isSafeOwner) {
                try IVaultSafe(safeAddress).isOwner(msg.sender) returns (bool result) {
                    isSafeOwner = result;
                } catch {}
            }
        }

        address protocolOwner = IProtocolCore(protocolCore).owner();
        isProtocolOwner = (msg.sender == protocolOwner);

        if (!isVaultItself && !isSafeOwner && !isProtocolOwner) revert NotAuthorized();
        _;
    }

    function addAdapter(bytes32 adapterId, address adapter) external onlyOwner {
        require(adapters[adapterId].adapterAddress == address(0), "Adapter exists");
        string memory name = ISwapAdapter(adapter).protocolName();
        adapters[adapterId] = AdapterInfo({
            adapterAddress: adapter,
            active: true,
            name: name
        });
        adapterIds.push(adapterId);
        
        if (defaultAdapterId == bytes32(0)) {
            defaultAdapterId = adapterId;
        }
        
        emit AdapterAdded(adapterId, adapter, name);
    }

    function updateAdapter(bytes32 adapterId, address newAdapter) external onlyOwner {
        require(adapters[adapterId].adapterAddress != address(0), "Adapter not found");
        adapters[adapterId].adapterAddress = newAdapter;
        adapters[adapterId].name = ISwapAdapter(newAdapter).protocolName();
        emit AdapterUpdated(adapterId, newAdapter);
    }

    function setAdapterActive(bytes32 adapterId, bool active) external onlyOwner {
        require(adapters[adapterId].adapterAddress != address(0), "Adapter not found");
        adapters[adapterId].active = active;
    }

    function setDefaultAdapter(bytes32 adapterId) external onlyOwner {
        require(adapters[adapterId].adapterAddress != address(0), "Adapter not found");
        defaultAdapterId = adapterId;
        emit DefaultAdapterSet(adapterId);
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
    }

    function setDefaultSlippage(uint256 _slippageBps) external onlyOwner {
        require(_slippageBps <= 1000, "Slippage too high");
        defaultSlippageBps = _slippageBps;
    }

    function swap(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes32 adapterId
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 amountOut) {
        return _swap(vault, tokenIn, tokenOut, amountIn, minAmountOut, adapterId, block.timestamp);
    }

    function swapWithDeadline(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes32 adapterId,
        uint256 deadline
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 amountOut) {
        return _swap(vault, tokenIn, tokenOut, amountIn, minAmountOut, adapterId, deadline);
    }

    function _swap(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes32 adapterId,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert SwapExpired();
        if (amountIn == 0) revert ZeroAmount();
        
        bytes32 selectedAdapter = adapterId == bytes32(0) ? defaultAdapterId : adapterId;
        
        AdapterInfo storage adapterInfo = adapters[selectedAdapter];
        if (adapterInfo.adapterAddress == address(0)) revert AdapterNotFound();
        if (!adapterInfo.active) revert AdapterNotActive();

        ISwapAdapter adapter = ISwapAdapter(adapterInfo.adapterAddress);
        if (!adapter.isRouteSupported(tokenIn, tokenOut)) revert RouteNotSupported();

        uint256 balanceInBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 balanceOutBefore = IERC20(tokenOut).balanceOf(vault);

        IERC20(tokenIn).safeTransferFrom(vault, address(this), amountIn);
        IERC20(tokenIn).forceApprove(adapterInfo.adapterAddress, amountIn);

        amountOut = adapter.swap(tokenIn, tokenOut, amountIn, minAmountOut, vault);

        uint256 balanceOutAfter = IERC20(tokenOut).balanceOf(vault);
        uint256 actualReceived = balanceOutAfter - balanceOutBefore;
        
        if (actualReceived < minAmountOut) revert InsufficientOutput();
        amountOut = actualReceived;

        uint256 balanceInAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 excess = balanceInAfter - balanceInBefore;
        if (excess > 0) {
            IERC20(tokenIn).safeTransfer(vault, excess);
        }

        emit Swapped(vault, selectedAdapter, tokenIn, tokenOut, amountIn, amountOut);
    }

    function swapWithSlippage(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageBps
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 amountOut) {
        return _swapWithSlippage(vault, tokenIn, tokenOut, amountIn, slippageBps, block.timestamp);
    }

    function swapWithSlippageAndDeadline(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageBps,
        uint256 deadline
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 amountOut) {
        return _swapWithSlippage(vault, tokenIn, tokenOut, amountIn, slippageBps, deadline);
    }

    function _swapWithSlippage(
        address vault,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageBps,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert SwapExpired();
        if (amountIn == 0) revert ZeroAmount();
        
        AdapterInfo storage adapterInfo = adapters[defaultAdapterId];
        if (adapterInfo.adapterAddress == address(0)) revert AdapterNotFound();
        if (!adapterInfo.active) revert AdapterNotActive();

        ISwapAdapter adapter = ISwapAdapter(adapterInfo.adapterAddress);
        if (!adapter.isRouteSupported(tokenIn, tokenOut)) revert RouteNotSupported();

        uint256 quote = adapter.getQuote(tokenIn, tokenOut, amountIn);
        uint256 minAmountOut = (quote * (10000 - slippageBps)) / 10000;

        uint256 balanceInBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 balanceOutBefore = IERC20(tokenOut).balanceOf(vault);

        IERC20(tokenIn).safeTransferFrom(vault, address(this), amountIn);
        IERC20(tokenIn).forceApprove(adapterInfo.adapterAddress, amountIn);

        amountOut = adapter.swap(tokenIn, tokenOut, amountIn, minAmountOut, vault);

        uint256 balanceOutAfter = IERC20(tokenOut).balanceOf(vault);
        uint256 actualReceived = balanceOutAfter - balanceOutBefore;
        
        if (actualReceived < minAmountOut) revert InsufficientOutput();
        amountOut = actualReceived;

        uint256 balanceInAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 excess = balanceInAfter - balanceInBefore;
        if (excess > 0) {
            IERC20(tokenIn).safeTransfer(vault, excess);
        }

        emit Swapped(vault, defaultAdapterId, tokenIn, tokenOut, amountIn, amountOut);
    }

    function getQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes32 adapterId
    ) external view returns (uint256 amountOut) {
        bytes32 selectedAdapter = adapterId == bytes32(0) ? defaultAdapterId : adapterId;
        AdapterInfo storage adapterInfo = adapters[selectedAdapter];
        if (adapterInfo.adapterAddress == address(0)) return 0;
        
        ISwapAdapter adapter = ISwapAdapter(adapterInfo.adapterAddress);
        return adapter.getQuote(tokenIn, tokenOut, amountIn);
    }

    function getBestQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256 bestAmountOut, bytes32 bestAdapterId) {
        uint256 checkCount = adapterIds.length > MAX_ADAPTERS_TO_CHECK 
            ? MAX_ADAPTERS_TO_CHECK 
            : adapterIds.length;
            
        for (uint256 i = 0; i < checkCount; i++) {
            bytes32 adapterId = adapterIds[i];
            AdapterInfo storage adapterInfo = adapters[adapterId];
            
            if (!adapterInfo.active) continue;
            
            ISwapAdapter adapter = ISwapAdapter(adapterInfo.adapterAddress);
            if (!adapter.isRouteSupported(tokenIn, tokenOut)) continue;
            
            uint256 quote = adapter.getQuote(tokenIn, tokenOut, amountIn);
            if (quote > bestAmountOut) {
                bestAmountOut = quote;
                bestAdapterId = adapterId;
            }
        }
    }

    function getAdapterCount() external view returns (uint256) {
        return adapterIds.length;
    }
}
