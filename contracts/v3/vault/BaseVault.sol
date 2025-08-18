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
        require(router_ != address(0), "ZeroRouter");
        router = IStrategyRouter(router_);
        emit RouterSet(router_);
    }

    function setPayoutPolicy(address policy_) external override onlyOwner {
        require(policy_ != address(0), "ZeroPayout");
        payoutPolicy = IPayoutPolicy(policy_);
        emit PayoutPolicySet(policy_);
    }

    function setLockupPolicy(address policy_) external override onlyOwner {
        require(policy_ != address(0), "ZeroLockup");
        lockupPolicy = ILockupPolicy(policy_);
        emit LockupPolicySet(policy_);
    }

    function setStakeholderRegistry(address registry_) external override onlyOwner {
        require(registry_ != address(0), "ZeroRegistry");
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

        // Ensure liquidity: if idle < assetsNeeded, pull back from strategies via router
        uint256 idle = IERC20(asset).balanceOf(address(this));
        if (idle < assetsNeeded) {
            require(address(router) != address(0), "RouterMissing");
            uint256 shortfall = assetsNeeded - idle;
            // Deallocate required amount back to this vault
            router.deallocate(shortfall);
            // refresh idle
            idle = IERC20(asset).balanceOf(address(this));
        }
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
        // Realize rewards (base asset returned to this vault)
        netAssets = router.harvest();
        if (netAssets == 0) return 0;

        // Compute streamed vs compounded portions per policy
        (uint256 streamed, /*uint256 compounded*/ ) = payoutPolicy.onHarvest(netAssets);
        if (streamed == 0) {
            return netAssets; // everything compounded/retained -> PPS increases
        }

        // Split streamed portion among stakeholders
        require(address(stakeholderRegistry) != address(0), "RegistryMissing");
        IStakeholderRegistry.Splits memory s = stakeholderRegistry.getSplits();
        uint256 ownerAmt = (streamed * s.ownerBps) / 10_000;
        uint256 verifierAmt = (streamed * s.verifierBps) / 10_000;
        // LP streamed portion is retained in vault as idle (benefits LPs via PPS)

        // Apply protocol rake on the owner portion using ShareToken settings
        address protocolReceiver = shareToken.protocolFeeReceiver();
        uint16 protocolRakeBps = shareToken.protocolRakeBps();
        uint256 protocolCut = protocolReceiver == address(0) ? 0 : (ownerAmt * protocolRakeBps) / 10_000;
        uint256 ownerNet = ownerAmt - protocolCut;

        // Move streamed funds into the payout policy for linear vesting
        IERC20(asset).safeTransfer(address(payoutPolicy), ownerNet + protocolCut + verifierAmt);

        // Accrue for owner recipient (net of protocol rake)
        address ownerRecipient = stakeholderRegistry.ownerRecipient();
        if (ownerNet > 0 && ownerRecipient != address(0)) {
            payoutPolicy.accrueFor(ownerRecipient, ownerNet);
        }

        // Accrue for protocol receiver (protocol cut streams as well)
        if (protocolCut > 0) {
            payoutPolicy.accrueFor(protocolReceiver, protocolCut);
        }

        // Accrue for verifiers equally (if any active)
        if (verifierAmt > 0) {
            address[] memory verifiers = stakeholderRegistry.activeVerifiers();
            uint256 n = verifiers.length;
            if (n > 0) {
                uint256 each = verifierAmt / n;
                uint256 remainder = verifierAmt - (each * n);
                for (uint256 i = 0; i < n; i++) {
                    if (each > 0) payoutPolicy.accrueFor(verifiers[i], each);
                }
                // keep any dust remainder in policy under owner recipient for simplicity
                if (remainder > 0 && ownerRecipient != address(0)) {
                    payoutPolicy.accrueFor(ownerRecipient, remainder);
                }
            }
        }
    }

    // Harvest only if minHarvestInterval has elapsed
    function harvestIfNeeded() external nonReentrant whenNotPaused returns (bool harvested, uint256 netAssets) {
        require(address(payoutPolicy) != address(0) && address(router) != address(0), "ModulesMissing");
        IPayoutPolicy.Config memory cfg = payoutPolicy.getConfig();
        uint256 last = payoutPolicy.lastHarvestAt();
        if (block.timestamp < last + cfg.minHarvestInterval) {
            return (false, 0);
        }
        netAssets = this.harvest();
        return (true, netAssets);
    }

    function rebalance(uint16[] calldata targetBps) external override onlyOwner whenNotPaused {
        require(address(router) != address(0), "RouterMissing");
        router.rebalance(targetBps);
    }

    // Allocate idle assets from this vault to strategies via router according to target bps
    function allocateToStrategies(uint256 amount) external onlyOwner whenNotPaused returns (uint256 deployed) {
        require(address(router) != address(0), "RouterMissing");
        require(amount > 0, "ZeroAmount");
        IERC20(asset).forceApprove(address(router), 0);
        IERC20(asset).forceApprove(address(router), amount);
        deployed = router.allocate(amount);
    }

    // Pull assets back from strategies to this vault according to target bps
    function deallocateFromStrategies(uint256 amount) external onlyOwner whenNotPaused returns (uint256 received) {
        require(address(router) != address(0), "RouterMissing");
        require(amount > 0, "ZeroAmount");
        received = router.deallocate(amount);
    }
}
