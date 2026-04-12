// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IBorrowAdapter.sol";

interface IProtocolCoreBorrowHub {
    function owner() external view returns (address);
}

interface IIndexSwapBorrowHub {
    function safe() external view returns (address);
    function getTotalValueUsd() external view returns (uint256);
}

interface IOracleBorrowHub {
    function priceUsdE18(address token) external view returns (uint256);
}

contract BorrowHub is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DIVISOR = 10000;

    address public immutable protocolCore;
    address public oracle;

    struct AdapterInfo {
        address adapterAddress;
        bool active;
        string name;
    }

    struct VaultDebtPosition {
        uint256 debtAmount;
        bytes32 adapterId;
        uint256 lastUpdateTime;
    }

    mapping(bytes32 => AdapterInfo) public adapters;
    bytes32[] public adapterIds;

    mapping(address => mapping(address => VaultDebtPosition)) public positions;
    mapping(address => address[]) public vaultTokens;
    mapping(address => mapping(address => bool)) public hasPosition;
    mapping(bytes32 => mapping(address => uint256)) public totalDebtByAdapterToken;

    event AdapterAdded(bytes32 indexed adapterId, address indexed adapter, string name);
    event AdapterUpdated(bytes32 indexed adapterId, address indexed newAdapter);
    event AdapterRemoved(bytes32 indexed adapterId);
    event Borrowed(address indexed vault, address indexed token, bytes32 indexed adapterId, uint256 amount);
    event Repaid(address indexed vault, address indexed token, bytes32 indexed adapterId, uint256 amount);
    event OracleUpdated(address indexed newOracle);

    error NotAuthorized();
    error AdapterNotFound();
    error AdapterNotActive();
    error TokenNotSupported();
    error ZeroAmount();
    error AdapterMismatch();
    error SolvencyCheckFailed();

    constructor(address _protocolCore, address _oracle) Ownable(msg.sender) {
        require(_protocolCore != address(0), "Invalid core");
        require(_oracle != address(0), "Invalid oracle");
        protocolCore = _protocolCore;
        oracle = _oracle;
    }

    modifier onlyAuthorized(address vault) {
        if (
            msg.sender != vault &&
            msg.sender != IIndexSwapBorrowHub(vault).safe() &&
            msg.sender != IProtocolCoreBorrowHub(protocolCore).owner()
        ) revert NotAuthorized();
        _;
    }

    function addAdapter(bytes32 adapterId, address adapter) external onlyOwner {
        require(adapter != address(0), "Invalid adapter");
        require(adapters[adapterId].adapterAddress == address(0), "Adapter exists");
        string memory name = IBorrowAdapter(adapter).protocolName();
        adapters[adapterId] = AdapterInfo({
            adapterAddress: adapter,
            active: true,
            name: name
        });
        adapterIds.push(adapterId);
        emit AdapterAdded(adapterId, adapter, name);
    }

    function updateAdapter(bytes32 adapterId, address newAdapter) external onlyOwner {
        require(newAdapter != address(0), "Invalid adapter");
        AdapterInfo storage info = adapters[adapterId];
        if (info.adapterAddress == address(0)) revert AdapterNotFound();
        info.adapterAddress = newAdapter;
        info.name = IBorrowAdapter(newAdapter).protocolName();
        emit AdapterUpdated(adapterId, newAdapter);
    }

    function setAdapterActive(bytes32 adapterId, bool active) external onlyOwner {
        AdapterInfo storage info = adapters[adapterId];
        if (info.adapterAddress == address(0)) revert AdapterNotFound();
        info.active = active;
    }

    function removeAdapter(bytes32 adapterId) external onlyOwner {
        AdapterInfo storage info = adapters[adapterId];
        if (info.adapterAddress == address(0)) revert AdapterNotFound();
        delete adapters[adapterId];
        emit AdapterRemoved(adapterId);
    }

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }

    function borrow(
        address vault,
        address token,
        uint256 amount,
        bytes32 adapterId
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 debtIssued) {
        if (amount == 0) revert ZeroAmount();

        AdapterInfo storage info = adapters[adapterId];
        if (info.adapterAddress == address(0)) revert AdapterNotFound();
        if (!info.active) revert AdapterNotActive();

        IBorrowAdapter adapter = IBorrowAdapter(info.adapterAddress);
        if (!adapter.isTokenSupported(token)) revert TokenNotSupported();

        VaultDebtPosition storage pos = positions[vault][token];
        if (pos.debtAmount > 0 && pos.adapterId != adapterId) revert AdapterMismatch();

        _checkSolvencyAfterBorrow(vault, token, amount, adapter);

        debtIssued = adapter.borrow(token, amount, vault);
        require(debtIssued > 0, "Zero debt");

        if (!hasPosition[vault][token]) {
            hasPosition[vault][token] = true;
            vaultTokens[vault].push(token);
        }

        pos.debtAmount += debtIssued;
        pos.adapterId = adapterId;
        pos.lastUpdateTime = block.timestamp;
        totalDebtByAdapterToken[adapterId][token] += debtIssued;

        emit Borrowed(vault, token, adapterId, debtIssued);
    }

    function repay(
        address vault,
        address token,
        uint256 amount
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 debtRepaid) {
        if (amount == 0) revert ZeroAmount();

        VaultDebtPosition storage pos = positions[vault][token];
        if (pos.debtAmount == 0) return 0;

        AdapterInfo storage info = adapters[pos.adapterId];
        if (info.adapterAddress == address(0)) revert AdapterNotFound();

        IBorrowAdapter adapter = IBorrowAdapter(info.adapterAddress);

        uint256 toRepay = amount > pos.debtAmount ? pos.debtAmount : amount;
        IERC20(token).safeTransferFrom(vault, info.adapterAddress, toRepay);
        debtRepaid = adapter.repay(token, toRepay, vault);
        if (debtRepaid > pos.debtAmount) debtRepaid = pos.debtAmount;

        pos.debtAmount -= debtRepaid;
        pos.lastUpdateTime = block.timestamp;

        uint256 aggregate = totalDebtByAdapterToken[pos.adapterId][token];
        totalDebtByAdapterToken[pos.adapterId][token] = debtRepaid > aggregate ? 0 : aggregate - debtRepaid;

        emit Repaid(vault, token, pos.adapterId, debtRepaid);
    }

    function repayAll(
        address vault,
        address token
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 debtRepaid) {
        VaultDebtPosition storage pos = positions[vault][token];
        if (pos.debtAmount == 0) return 0;
        AdapterInfo storage info = adapters[pos.adapterId];
        if (info.adapterAddress == address(0)) revert AdapterNotFound();

        IBorrowAdapter adapter = IBorrowAdapter(info.adapterAddress);
        uint256 toRepay = pos.debtAmount;
        IERC20(token).safeTransferFrom(vault, info.adapterAddress, toRepay);
        debtRepaid = adapter.repay(token, toRepay, vault);
        if (debtRepaid > pos.debtAmount) debtRepaid = pos.debtAmount;

        pos.debtAmount -= debtRepaid;
        pos.lastUpdateTime = block.timestamp;

        uint256 aggregate = totalDebtByAdapterToken[pos.adapterId][token];
        totalDebtByAdapterToken[pos.adapterId][token] = debtRepaid > aggregate ? 0 : aggregate - debtRepaid;

        emit Repaid(vault, token, pos.adapterId, debtRepaid);
    }

    function getPosition(
        address vault,
        address token
    ) external view returns (uint256 debtAmount, uint256 debtValueUsd, bytes32 adapterId) {
        VaultDebtPosition storage pos = positions[vault][token];
        debtAmount = pos.debtAmount;
        adapterId = pos.adapterId;
        if (pos.debtAmount == 0) return (debtAmount, 0, adapterId);
        debtValueUsd = _tokenToUsd(token, pos.debtAmount);
    }

    function getPositionValue(address vault, address token) external view returns (uint256 valueUsd) {
        if (token == address(0)) {
            address[] storage tokens = vaultTokens[vault];
            for (uint256 i = 0; i < tokens.length; i++) {
                valueUsd += _tokenToUsd(tokens[i], positions[vault][tokens[i]].debtAmount);
            }
            return valueUsd;
        }
        return _tokenToUsd(token, positions[vault][token].debtAmount);
    }

    function getAdapterCount() external view returns (uint256) {
        return adapterIds.length;
    }

    function getVaultTokens(address vault) external view returns (address[] memory) {
        return vaultTokens[vault];
    }

    function _checkSolvencyAfterBorrow(address vault, address token, uint256 borrowAmount, IBorrowAdapter adapter) internal view {
        uint16 maxLtvBps = adapter.getMaxLtvBps(token);
        if (maxLtvBps == 0 || maxLtvBps > BPS_DIVISOR) revert SolvencyCheckFailed();

        uint256 currentDebtUsd = _getVaultDebtUsd(vault);
        uint256 projectedDebtUsd = currentDebtUsd + _tokenToUsd(token, borrowAmount);
        uint256 grossCollateralUsd = IIndexSwapBorrowHub(vault).getTotalValueUsd() + currentDebtUsd;

        if (grossCollateralUsd == 0) revert SolvencyCheckFailed();
        if (projectedDebtUsd * BPS_DIVISOR > grossCollateralUsd * maxLtvBps) revert SolvencyCheckFailed();
    }

    function _getVaultDebtUsd(address vault) internal view returns (uint256 debtUsd) {
        address[] storage tokens = vaultTokens[vault];
        for (uint256 i = 0; i < tokens.length; i++) {
            debtUsd += _tokenToUsd(tokens[i], positions[vault][tokens[i]].debtAmount);
        }
    }

    function _tokenToUsd(address token, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        uint8 decimals = IERC20Metadata(token).decimals();
        uint256 price = IOracleBorrowHub(oracle).priceUsdE18(token);
        return (amount * price) / (10 ** decimals);
    }
}
