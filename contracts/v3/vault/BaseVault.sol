// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/IBaseVault.sol";
import "../interfaces/IStrategyRouter.sol";
import "../interfaces/IPayoutPolicy.sol";
import "../interfaces/ILockupPolicy.sol";
import "../interfaces/IStakeholderRegistry.sol";
import "../interfaces/IShareToken.sol";
import "../interfaces/IPriceOracle.sol";
import "../tokens/ShareToken.sol";

/**
 * @title BaseVault (Dexponent v3)
 * @notice ERC-4626-like vault with modular policies and a strategy router.
 *         - NAV/share accounting with external strategy holdings via router
 *         - Pluggable payout and lockup policies
 *         - Share token with optional transfer fee
 *
 *         This contract intentionally focuses on correct accounting and
 *         safe flows. Strategy logic lives in the router and adapters.
 */
contract BaseVault is IBaseVault, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // Immutable base asset for this vault
    address public immutable override asset;

    // Share token minted/burned by this vault
    IShareToken public shareToken;

    // Modules
    IStrategyRouter public router;
    IPayoutPolicy public payoutPolicy;
    ILockupPolicy public lockupPolicy;
    IStakeholderRegistry public stakeholderRegistry;

    event RouterSet(address indexed router);
    event PayoutPolicySet(address indexed policy);
    event LockupPolicySet(address indexed policy);
    event StakeholderRegistrySet(address indexed registry);

    constructor(address asset_, string memory name_, string memory symbol_) Ownable(msg.sender) {
        require(asset_ != address(0), "InvalidAsset");
        asset = asset_;

        // Deploy a dedicated share token, set this vault as minter, then hand ownership to farm owner
        ShareToken token = new ShareToken(name_, symbol_);
        token.setMinter(address(this));
        token.transferOwnership(msg.sender);
        shareToken = IShareToken(address(token));
    }

    // --- Admin wiring ---

    function setStrategyRouter(address router_) external override onlyOwner {
        router = IStrategyRouter(router_);
        emit RouterSet(router_);
    }

    function setPayoutPolicy(address policy_) external override onlyOwner {
        payoutPolicy = IPayoutPolicy(policy_);
        emit PayoutPolicySet(policy_);
    }

    function setLockupPolicy(address policy_) external override onlyOwner {
        lockupPolicy = ILockupPolicy(policy_);
        emit LockupPolicySet(policy_);
    }

    function setStakeholderRegistry(address registry_) external override onlyOwner {
        stakeholderRegistry = IStakeholderRegistry(registry_);
        emit StakeholderRegistrySet(registry_);
    }

    function pause() external override onlyOwner { _pause(); }
    function unpause() external override onlyOwner { _unpause(); }

    // --- Views ---

    function totalAssets() public view override returns (uint256) {
        uint256 idle = IERC20(asset).balanceOf(address(this));
        uint256 invested = address(router) == address(0) ? 0 : router.totalAssets();
        return idle + invested;
    }

    function convertToShares(uint256 assets) public view override returns (uint256 shares) {
        uint256 supply = IERC20(address(shareToken)).totalSupply();
        uint256 ta = totalAssets();
        if (supply == 0 || ta == 0) {
            return assets; // 1:1 on first mint
        }
        return (assets * supply) / ta;
    }

    function convertToAssets(uint256 shares) public view override returns (uint256 assets) {
        uint256 supply = IERC20(address(shareToken)).totalSupply();
        uint256 ta = totalAssets();
        if (supply == 0) return 0;
        return (shares * ta) / supply;
    }

    // --- Core flows ---

    function deposit(uint256 assets, address receiver) external override nonReentrant whenNotPaused returns (uint256 shares) {
        require(assets > 0, "ZeroAssets");
        shares = convertToShares(assets);
        require(shares > 0, "ZeroShares");

        // pull assets
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);

        // lockup hook
        if (address(lockupPolicy) != address(0)) {
            lockupPolicy.onDeposit(receiver, assets);
        }

        // mint shares
        shareToken.mint(receiver, shares);
    }

    function mint(uint256 shares, address receiver) external override nonReentrant whenNotPaused returns (uint256 assets) {
        require(shares > 0, "ZeroShares");
        assets = convertToAssets(shares);
        require(assets > 0, "ZeroAssets");

        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        if (address(lockupPolicy) != address(0)) {
            lockupPolicy.onDeposit(receiver, assets);
        }
        shareToken.mint(receiver, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner_) external override nonReentrant returns (uint256 shares) {
        require(assets > 0, "ZeroAssets");
        shares = convertToShares(assets);
        _withdraw(shares, assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_) external override nonReentrant returns (uint256 assets) {
        require(shares > 0, "ZeroShares");
        assets = convertToAssets(shares);
        _withdraw(shares, assets, receiver, owner_);
    }

    function _withdraw(uint256 shares, uint256 assetsNeeded, address receiver, address owner_) internal {
        // Restrict to owner-only for MVP; allowance-based redemption can be added later
        require(msg.sender == owner_, "NotOwner");

        // Burn shares from owner_
        shareToken.burn(owner_, shares);

        // Apply lockup and penalty
        uint256 penalty = 0;
        if (address(lockupPolicy) != address(0)) {
            penalty = lockupPolicy.enforceWithdrawal(owner_, assetsNeeded);
        }

        // Ensure liquidity: if idle < assetsNeeded, deallocation logic will be added later
        uint256 idle = IERC20(asset).balanceOf(address(this));
        require(idle >= assetsNeeded, "InsufficientLiquidity");

        uint256 payout = assetsNeeded;
        if (penalty > 0) {
            require(penalty < assetsNeeded, "BadPenalty");
            payout = assetsNeeded - penalty;
            // Penalty remains in vault, effectively benefiting remaining LPs via PPS
        }

        IERC20(asset).safeTransfer(receiver, payout);
    }

    // --- Strategy ops ---

    function harvest() external override nonReentrant whenNotPaused returns (uint256 netAssets) {
        require(address(router) != address(0), "RouterMissing");
        require(address(payoutPolicy) != address(0), "PayoutMissing");
        // Router expected to realize rewards and return base assets to this vault
        netAssets = router.harvest();
        // Payout/compound split handled by policy; for MVP we'll keep all in vault until policy is wired
        // Future: payoutPolicy.onHarvest(netAssets)
    }

    function rebalance(uint16[] calldata targetBps) external override onlyOwner whenNotPaused {
        require(address(router) != address(0), "RouterMissing");
        router.rebalance(targetBps);
    }
}
