// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../interfaces/ICoreAccessControl.sol";
import "../interfaces/IVault.sol";

interface IUsdPricerV {
    function priceUsdE18(address token) external view returns (uint256);
}

interface IAssetsValuer {
    function assetsOfVault(address asset, address vault) external view returns (uint256);
}

contract Vault4626 is IVault, ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable override asset;
    uint8 private immutable _assetDecimals;

    address public usdPricer;
    address public assetsValuer; // optional external valuation of non-held positions

    event UsdPricerSet(address pricer);
    event AssetsValuerSet(address valuer);
    event TvlUpdated(uint256 totalAssets);
    event ActionExecuted(address indexed target, bytes data, bytes result);
    event AssetApproval(address indexed spender, uint256 amount);

    constructor(address asset_, address core_, string memory name_, string memory symbol_) ERC20(name_, symbol_) Ownable(core_) {
        require(asset_ != address(0), "AssetZero");
        asset = asset_;
        _assetDecimals = IERC20Metadata(asset_).decimals();
    }

    modifier whenCoreNotPaused() {
        if (owner() != address(0)) {
            bool gp = ICoreAccessControl(owner()).isGlobalPaused();
            bool vp = ICoreAccessControl(owner()).isVaultPaused(address(this));
            require(!gp && !vp, "Paused");
        }
        _;
    }

    modifier onlyCoreOperator() {
        address core = owner();
        require(core != address(0), "NoCore");
        require(ICoreAccessControl(core).canOperate(address(this), msg.sender) || msg.sender == core, "NoOp");
        _;
    }

    function decimals() public view override returns (uint8) { return _assetDecimals; }

    // IVault views
    function totalAssets() public view override returns (uint256) {
        uint256 idle = IERC20(asset).balanceOf(address(this));
        if (assetsValuer == address(0)) return idle;
        uint256 ext = IAssetsValuer(assetsValuer).assetsOfVault(asset, address(this));
        return idle + ext;
    }

    function convertToShares(uint256 assets_) public view override returns (uint256 shares) {
        uint256 supply = totalSupply();
        if (supply == 0) return assets_;
        uint256 ta = totalAssets();
        require(ta > 0, "NAV0");
        return (assets_ * supply) / ta;
    }

    function convertToAssets(uint256 shares_) public view override returns (uint256 assets_) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        uint256 ta = totalAssets();
        return (shares_ * ta) / supply;
    }

    function _previewWithdrawShares(uint256 assets_) internal view returns (uint256 shares_) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        uint256 ta = totalAssets();
        // round up: ceil(assets * supply / ta)
        shares_ = (assets_ * supply + (ta - 1)) / ta;
    }

    // Flows
    function deposit(uint256 assets_, address receiver) external override whenCoreNotPaused nonReentrant returns (uint256 shares) {
        require(assets_ > 0, "ZeroAssets");
        uint256 cap = ICoreAccessControl(owner()).tvlCapOf(address(this));
        if (cap > 0) {
            require(totalAssets() + assets_ <= cap, "Cap");
        }
        shares = convertToShares(assets_);
        require(shares > 0, "ZeroShares");
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets_);
        _mint(receiver, shares);
        emit TvlUpdated(totalAssets());
    }

    function mint(uint256 shares_, address receiver) external override whenCoreNotPaused nonReentrant returns (uint256 assets_) {
        require(shares_ > 0, "ZeroShares");
        assets_ = convertToAssets(shares_);
        require(assets_ > 0, "ZeroAssets");
        uint256 cap = ICoreAccessControl(owner()).tvlCapOf(address(this));
        if (cap > 0) {
            require(totalAssets() + assets_ <= cap, "Cap");
        }
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets_);
        _mint(receiver, shares_);
        emit TvlUpdated(totalAssets());
    }

    function withdraw(uint256 assets_, address receiver, address owner_) external override whenCoreNotPaused nonReentrant returns (uint256 shares_) {
        require(assets_ > 0, "ZeroAssets");
        shares_ = _previewWithdrawShares(assets_);
        if (msg.sender != owner_) {
            uint256 al = allowance(owner_, msg.sender);
            require(al >= shares_, "Allow");
            _approve(owner_, msg.sender, al - shares_);
        }
        _burn(owner_, shares_);
        IERC20(asset).safeTransfer(receiver, assets_);
        emit TvlUpdated(totalAssets());
    }

    function redeem(uint256 shares_, address receiver, address owner_) external override whenCoreNotPaused nonReentrant returns (uint256 assets_) {
        require(shares_ > 0, "ZeroShares");
        if (msg.sender != owner_) {
            uint256 al = allowance(owner_, msg.sender);
            require(al >= shares_, "Allow");
            _approve(owner_, msg.sender, al - shares_);
        }
        assets_ = convertToAssets(shares_);
        _burn(owner_, shares_);
        IERC20(asset).safeTransfer(receiver, assets_);
        emit TvlUpdated(totalAssets());
    }

    // Pricing helpers
    function pricePerShareE18() external view override returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        return (totalAssets() * 1e18) / supply;
    }

    function totalAssetsUsdE18() external view override returns (uint256) {
        require(usdPricer != address(0), "Pricer");
        uint256 ta = totalAssets();
        if (ta == 0) return 0;
        uint256 p = IUsdPricerV(usdPricer).priceUsdE18(asset);
        return (ta * p) / (10 ** _assetDecimals);
    }

    function pricePerShareUsdE18() external view override returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        require(usdPricer != address(0), "Pricer");
        uint256 p = IUsdPricerV(usdPricer).priceUsdE18(asset);
        uint256 ppsBase = (totalAssets() * 1e18) / supply;
        return (ppsBase * p) / (10 ** _assetDecimals);
    }

    // Owner-gated
    function setUsdPricer(address pricer) external onlyOwner {
        usdPricer = pricer;
        emit UsdPricerSet(pricer);
    }

    function setAssetsValuer(address valuer) external onlyOwner {
        assetsValuer = valuer;
        emit AssetsValuerSet(valuer);
    }

    function approveAsset(address spender, uint256 amount) external override onlyCoreOperator nonReentrant {
        IERC20(asset).forceApprove(spender, 0);
        IERC20(asset).forceApprove(spender, amount);
        emit AssetApproval(spender, amount);
    }

    function executeAction(address target, bytes calldata data) external override onlyCoreOperator nonReentrant returns (bytes memory result) {
        require(target != address(0), "ZeroTarget");
        require(ICoreAccessControl(owner()).isActionAllowed(address(this), target), "TargetBlocked");
        (bool ok, bytes memory res) = target.call(data);
        require(ok, "CallFail");
        emit ActionExecuted(target, data, res);
        return res;
    }
}
