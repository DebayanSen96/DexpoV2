// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ILendingAdapter.sol";

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

contract LendingHub is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable protocolCore;
    address public oracle;

    struct VaultPosition {
        uint256 shares;
        uint256 suppliedAmount;
        uint256 lastUpdateTime;
        bytes32 adapterId;
    }

    struct AdapterInfo {
        address adapterAddress;
        bool active;
        string name;
    }

    mapping(bytes32 => AdapterInfo) public adapters;
    bytes32[] public adapterIds;
    
    mapping(address => mapping(address => VaultPosition)) public positions;
    mapping(address => address[]) public vaultTokens;
    mapping(address => mapping(address => bool)) public hasPosition;
    mapping(bytes32 => mapping(address => uint256)) public totalShares;
    mapping(bytes32 => mapping(address => uint256)) public totalSuppliedAmount;
    
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    event AdapterAdded(bytes32 indexed adapterId, address indexed adapter, string name);
    event AdapterRemoved(bytes32 indexed adapterId);
    event AdapterUpdated(bytes32 indexed adapterId, address indexed newAdapter);
    event Supplied(address indexed vault, address indexed token, bytes32 indexed adapterId, uint256 amount, uint256 shares);
    event Withdrawn(address indexed vault, address indexed token, uint256 amount, uint256 shares);

    error NotAuthorized();
    error AdapterNotFound();
    error AdapterNotActive();
    error TokenNotSupported();
    error InsufficientPosition();
    error ZeroAmount();
    error AdapterMismatch();

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
        string memory name = ILendingAdapter(adapter).protocolName();
        adapters[adapterId] = AdapterInfo({
            adapterAddress: adapter,
            active: true,
            name: name
        });
        adapterIds.push(adapterId);
        emit AdapterAdded(adapterId, adapter, name);
    }

    function updateAdapter(bytes32 adapterId, address newAdapter) external onlyOwner {
        require(adapters[adapterId].adapterAddress != address(0), "Adapter not found");
        adapters[adapterId].adapterAddress = newAdapter;
        adapters[adapterId].name = ILendingAdapter(newAdapter).protocolName();
        emit AdapterUpdated(adapterId, newAdapter);
    }

    function setAdapterActive(bytes32 adapterId, bool active) external onlyOwner {
        require(adapters[adapterId].adapterAddress != address(0), "Adapter not found");
        adapters[adapterId].active = active;
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
    }

    function supply(
        address vault,
        address token,
        uint256 amount,
        bytes32 adapterId
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        
        AdapterInfo storage adapterInfo = adapters[adapterId];
        if (adapterInfo.adapterAddress == address(0)) revert AdapterNotFound();
        if (!adapterInfo.active) revert AdapterNotActive();
        
        ILendingAdapter adapter = ILendingAdapter(adapterInfo.adapterAddress);
        if (!adapter.isTokenSupported(token)) revert TokenNotSupported();

        IERC20(token).safeTransferFrom(vault, adapterInfo.adapterAddress, amount);

        shares = adapter.supply(token, amount, address(this));

        VaultPosition storage pos = positions[vault][token];
        if (pos.shares > 0 && pos.adapterId != adapterId) revert AdapterMismatch();
        
        if (!hasPosition[vault][token]) {
            hasPosition[vault][token] = true;
            vaultTokens[vault].push(token);
        }

        pos.shares += shares;
        pos.suppliedAmount += amount;
        pos.lastUpdateTime = block.timestamp;
        pos.adapterId = adapterId;
        totalShares[adapterId][token] += shares;
        totalSuppliedAmount[adapterId][token] += amount;

        emit Supplied(vault, token, adapterId, amount, shares);
    }

    function withdraw(
        address vault,
        address token,
        uint256 amount
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 withdrawn) {
        if (amount == 0) revert ZeroAmount();
        
        VaultPosition storage pos = positions[vault][token];
        if (pos.shares == 0) revert InsufficientPosition();

        AdapterInfo storage adapterInfo = adapters[pos.adapterId];
        if (adapterInfo.adapterAddress == address(0)) revert AdapterNotFound();

        ILendingAdapter adapter = ILendingAdapter(adapterInfo.adapterAddress);

        uint256 currentValue = _getShareValue(pos.adapterId, token, pos.shares);
        if (currentValue == 0) revert InsufficientPosition();
        uint256 prevShares = pos.shares;
        uint256 sharesToBurn;
        
        if (amount >= currentValue) {
            sharesToBurn = pos.shares;
            amount = currentValue;
        } else {
            sharesToBurn = (pos.shares * amount) / currentValue;
        }

        address shareToken = adapter.getShareToken(token);
        IERC20(shareToken).safeTransfer(adapterInfo.adapterAddress, sharesToBurn);
        
        withdrawn = adapter.withdraw(token, sharesToBurn, vault);

        pos.shares -= sharesToBurn;
        totalShares[pos.adapterId][token] -= sharesToBurn;
        uint256 principalReduction = (pos.suppliedAmount * sharesToBurn) / prevShares;
        if (principalReduction > pos.suppliedAmount) {
            principalReduction = pos.suppliedAmount;
        }
        pos.suppliedAmount -= principalReduction;
        
        if (totalSuppliedAmount[pos.adapterId][token] >= principalReduction) {
            totalSuppliedAmount[pos.adapterId][token] -= principalReduction;
        } else {
            totalSuppliedAmount[pos.adapterId][token] = 0;
        }
        pos.lastUpdateTime = block.timestamp;

        emit Withdrawn(vault, token, withdrawn, sharesToBurn);
    }

    function withdrawAll(
        address vault,
        address token
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 withdrawn) {
        VaultPosition storage pos = positions[vault][token];
        if (pos.shares == 0) revert InsufficientPosition();

        AdapterInfo storage adapterInfo = adapters[pos.adapterId];
        if (adapterInfo.adapterAddress == address(0)) revert AdapterNotFound();

        ILendingAdapter adapter = ILendingAdapter(adapterInfo.adapterAddress);
        
        address shareToken = adapter.getShareToken(token);
        IERC20(shareToken).safeTransfer(adapterInfo.adapterAddress, pos.shares);

        withdrawn = adapter.withdraw(token, pos.shares, vault);

        uint256 burnedShares = pos.shares;
        uint256 suppliedToRemove = pos.suppliedAmount;
        pos.shares = 0;
        totalShares[pos.adapterId][token] -= burnedShares;
        pos.suppliedAmount = 0;
        
        if (totalSuppliedAmount[pos.adapterId][token] >= suppliedToRemove) {
            totalSuppliedAmount[pos.adapterId][token] -= suppliedToRemove;
        } else {
            totalSuppliedAmount[pos.adapterId][token] = 0;
        }
        pos.lastUpdateTime = block.timestamp;

        emit Withdrawn(vault, token, withdrawn, burnedShares);
    }

    function getPosition(address vault, address token) external view returns (
        uint256 suppliedAmount,
        uint256 currentBalance,
        uint256 shares,
        uint256 earnedInterest,
        bytes32 adapterId
    ) {
        VaultPosition storage pos = positions[vault][token];
        suppliedAmount = pos.suppliedAmount;
        shares = pos.shares;
        adapterId = pos.adapterId;

        if (pos.shares > 0 && adapters[pos.adapterId].adapterAddress != address(0)) {
            currentBalance = _getShareValue(pos.adapterId, token, pos.shares);
            earnedInterest = currentBalance > suppliedAmount ? currentBalance - suppliedAmount : 0;
        }
    }

    function getPositionValue(address vault, address token) external view returns (uint256 valueUsd) {
        if (token == address(0)) {
            address[] storage tokens = vaultTokens[vault];
            for (uint256 i = 0; i < tokens.length; i++) {
                valueUsd += _getPositionValueForToken(vault, tokens[i]);
            }
        } else {
            valueUsd = _getPositionValueForToken(vault, token);
        }
    }

    function _getPositionValueForToken(address vault, address token) internal view returns (uint256) {
        VaultPosition storage pos = positions[vault][token];
        if (pos.shares == 0) return 0;

        AdapterInfo storage adapterInfo = adapters[pos.adapterId];
        if (adapterInfo.adapterAddress == address(0)) return 0;

        uint256 tokenAmount = _getShareValue(pos.adapterId, token, pos.shares);
        if (tokenAmount == 0) return 0;

        uint256 priceUsd = IOracle(oracle).priceUsdE18(token);
        uint8 decimals = IERC20Metadata(token).decimals();

        return (tokenAmount * priceUsd) / (10 ** decimals);
    }

    function _getShareValue(bytes32 adapterId, address token, uint256 shares) internal view returns (uint256) {
        if (shares == 0) return 0;
        AdapterInfo storage adapterInfo = adapters[adapterId];
        if (adapterInfo.adapterAddress == address(0)) return 0;

        uint256 totalUnderlying = ILendingAdapter(adapterInfo.adapterAddress).getTotalShares(token);
        uint256 totalSharesForToken = totalShares[adapterId][token];
        
        uint256 totalSharesWithVirtual = totalSharesForToken + VIRTUAL_SHARES;
        uint256 totalUnderlyingWithVirtual = totalUnderlying + VIRTUAL_ASSETS;
        
        if (totalUnderlyingWithVirtual == 0 || totalSharesWithVirtual == 0) return 0;

        return (shares * totalUnderlyingWithVirtual) / totalSharesWithVirtual;
    }

    function getAdapterCount() external view returns (uint256) {
        return adapterIds.length;
    }

    function getVaultTokens(address vault) external view returns (address[] memory) {
        return vaultTokens[vault];
    }
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}
