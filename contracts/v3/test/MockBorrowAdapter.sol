// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../mainnet/modules/borrow/IBorrowAdapter.sol";
import "../../mocks/MockERC20.sol";

contract MockBorrowAdapter is IBorrowAdapter, Ownable {
    using SafeERC20 for IERC20;

    address public borrowHub;

    struct TokenConfig {
        bool supported;
        uint16 maxLtvBps;
        uint256 borrowCap;
        uint256 interestRateE18;
        uint256 totalDebt;
    }

    mapping(address => TokenConfig) public tokenConfigs;
    mapping(address => mapping(address => uint256)) public vaultDebtByToken;

    event BorrowHubUpdated(address indexed newHub);
    event TokenConfigured(
        address indexed token,
        bool supported,
        uint16 maxLtvBps,
        uint256 borrowCap,
        uint256 interestRateE18
    );

    error OnlyHub();
    error TokenNotSupported();
    error BorrowCapExceeded();

    constructor() Ownable(msg.sender) {}

    modifier onlyHub() {
        if (msg.sender != borrowHub) revert OnlyHub();
        _;
    }

    function setBorrowHub(address _hub) external onlyOwner {
        borrowHub = _hub;
        emit BorrowHubUpdated(_hub);
    }

    function setTokenConfig(
        address token,
        bool supported,
        uint16 maxLtvBps,
        uint256 borrowCap,
        uint256 interestRateE18
    ) public onlyOwner {
        require(token != address(0), "Invalid token");
        require(maxLtvBps <= 10000, "LTV too high");
        tokenConfigs[token].supported = supported;
        tokenConfigs[token].maxLtvBps = maxLtvBps;
        tokenConfigs[token].borrowCap = borrowCap;
        tokenConfigs[token].interestRateE18 = interestRateE18;
        emit TokenConfigured(token, supported, maxLtvBps, borrowCap, interestRateE18);
    }

    function setTokenConfigs(
        address[] calldata tokens,
        bool[] calldata supported,
        uint16[] calldata maxLtvBps,
        uint256[] calldata borrowCaps,
        uint256[] calldata interestRatesE18
    ) external onlyOwner {
        uint256 len = tokens.length;
        require(
            len == supported.length &&
            len == maxLtvBps.length &&
            len == borrowCaps.length &&
            len == interestRatesE18.length,
            "Length mismatch"
        );
        for (uint256 i = 0; i < len; i++) {
            setTokenConfig(tokens[i], supported[i], maxLtvBps[i], borrowCaps[i], interestRatesE18[i]);
        }
    }

    function protocolName() external pure override returns (string memory) {
        return "Mock Borrow";
    }

    function borrow(address token, uint256 amount, address onBehalfOf) external override onlyHub returns (uint256 debtIssued) {
        TokenConfig storage cfg = tokenConfigs[token];
        if (!cfg.supported) revert TokenNotSupported();
        uint256 nextTotalDebt = cfg.totalDebt + amount;
        if (cfg.borrowCap > 0 && nextTotalDebt > cfg.borrowCap) revert BorrowCapExceeded();

        cfg.totalDebt = nextTotalDebt;
        vaultDebtByToken[onBehalfOf][token] += amount;
        MockERC20(token).mint(onBehalfOf, amount);
        return amount;
    }

    function repay(address token, uint256 amount, address onBehalfOf) external override onlyHub returns (uint256 debtRepaid) {
        TokenConfig storage cfg = tokenConfigs[token];
        if (!cfg.supported) revert TokenNotSupported();

        uint256 currentDebt = vaultDebtByToken[onBehalfOf][token];
        debtRepaid = amount > currentDebt ? currentDebt : amount;
        if (debtRepaid == 0) return 0;

        vaultDebtByToken[onBehalfOf][token] = currentDebt - debtRepaid;
        cfg.totalDebt = debtRepaid > cfg.totalDebt ? 0 : cfg.totalDebt - debtRepaid;
        MockERC20(token).burn(address(this), debtRepaid);
    }

    function getDebtValue(address vault, address token) external view override returns (uint256 tokenAmount) {
        return vaultDebtByToken[vault][token];
    }

    function getTotalDebt(address token) external view override returns (uint256) {
        return tokenConfigs[token].totalDebt;
    }

    function getVaultDebt(address vault, address token) external view override returns (uint256) {
        return vaultDebtByToken[vault][token];
    }

    function isTokenSupported(address token) external view override returns (bool) {
        return tokenConfigs[token].supported;
    }

    function getMaxLtvBps(address token) external view override returns (uint16) {
        return tokenConfigs[token].maxLtvBps;
    }

    function getBorrowCap(address token) external view override returns (uint256) {
        return tokenConfigs[token].borrowCap;
    }

    function getTokenDecimals(address token) external view returns (uint8) {
        return _safeDecimals(token);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    function _safeDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 dec) {
            return dec;
        } catch {
            return 18;
        }
    }
}

