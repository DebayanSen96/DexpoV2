// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/IBaseFarm.sol";
import "../interfaces/IStrategyRouter.sol";
import "../interfaces/IPayoutPolicy.sol";
import "../interfaces/ILockupPolicy.sol";
import "../interfaces/IStakeholderRegistry.sol";
import "../interfaces/IShareToken.sol";
import "../interfaces/IPriceOracle.sol";
import "../interfaces/IProtocolCore.sol";
import "../tokens/ShareToken.sol";

// Minimal interface to read the ProtocolCore owner
interface IHasOwner {
    function owner() external view returns (address);
}

/**
 * @title BaseFarm (Dexponent v3)
 * @notice ERC-4626-like farm with modular policies and a strategy router.
 *         - NAV/share accounting with external strategy holdings via router
 *         - Pluggable payout and lockup policies
 *         - Share token with optional transfer fee
 *
 *         This contract intentionally focuses on correct accounting and
 *         safe flows. Strategy logic lives in the router and adapters.
 */
contract BaseFarm is IBaseFarm, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice ERC-20 principal token accepted by the farm.
    address public override asset;

    /// @notice ProtocolCore contract used to authorize sensitive updates.
    address public protocolCore;

    /// @notice Unique farm identifier assigned by ProtocolCore.
    uint256 public farmId;

    /// @notice ERC-20 share token minted/burned by this farm.
    IShareToken public shareToken;

    /// @notice Strategy router managing strategy adapters and invested assets.
    IStrategyRouter public router;
    /// @notice Payout policy contract for streaming distributions.
    IPayoutPolicy public payoutPolicy;
    /// @notice Lockup policy contract enforcing deposit/withdraw rules.
    ILockupPolicy public lockupPolicy;
    /// @notice Registry of owner/verifier stakeholders and their splits.
    IStakeholderRegistry public stakeholderRegistry;

    /// @notice Emitted when the router is updated.
    event RouterSet(address indexed router);
    /// @notice Emitted when the payout policy is updated.
    event PayoutPolicySet(address indexed policy);
    /// @notice Emitted when the lockup policy is updated.
    event LockupPolicySet(address indexed policy);
    /// @notice Emitted when the stakeholder registry is updated.
    event StakeholderRegistrySet(address indexed registry);

    /// @notice Parameterless constructor to satisfy Ownable base. Not used by clones.
    constructor() Ownable(msg.sender) {}

    bool private _initialized;

    /**
     * @notice Initialize BaseFarm and deploy its dedicated `ShareToken`.
     * @param asset_ ERC-20 principal token address.
     * @param name_ Name for the share token.
     * @param symbol_ Symbol for the share token.
     * @param protocolCore_ ProtocolCore contract address.
     * @param farmId_ Unique farm identifier assigned by the protocol.
     * @param initialOwner Owner to assign for admin functions (factory during wiring).
     */
    function initialize(
        address asset_,
        string memory name_,
        string memory symbol_,
        address protocolCore_,
        uint256 farmId_,
        address initialOwner
    ) external {
        require(!_initialized, "Init");
        require(asset_ != address(0), "InvalidAsset");
        require(protocolCore_ != address(0) && initialOwner != address(0), "InvalidCoreOrOwner");
        asset = asset_;
        protocolCore = protocolCore_;
        farmId = farmId_;

        // Deploy a dedicated share token, set this farm as minter, then hand ownership to factory (initialOwner)
        ShareToken token = new ShareToken(name_, symbol_);
        token.setMinter(address(this));
        token.transferOwnership(initialOwner);
        shareToken = IShareToken(address(token));

        _transferOwnership(initialOwner);
        _initialized = true;
    }

    // --- Admin wiring ---

    /// @dev Internal helper: returns true if `msg.sender` is the ProtocolCore owner.
    function _isProtocolOwner() internal view returns (bool) {
        return IHasOwner(protocolCore).owner() == msg.sender;
    }

    /**
     * @notice Sets or updates the strategy router.
     * @dev First set allowed by farm owner or ProtocolCore owner; subsequent updates only by ProtocolCore owner.
     * @param router_ Router contract address.
     */
    function setStrategyRouter(address router_) external override {
        require(router_ != address(0), "ZeroRouter");
        // Allow factory (initial owner) to set once; thereafter only protocol owner may change
        if (address(router) == address(0)) {
            require(msg.sender == owner() || _isProtocolOwner(), "NotFactoryOrProtocol");
        } else {
            require(_isProtocolOwner(), "OnlyProtocol");
        }
        router = IStrategyRouter(router_);
        emit RouterSet(router_);
    }

    /**
     * @notice Sets or updates the payout policy.
     * @dev First set allowed by farm owner or ProtocolCore owner; subsequent updates only by ProtocolCore owner.
     * @param policy_ Payout policy contract address.
     */
    function setPayoutPolicy(address policy_) external override {
        require(policy_ != address(0), "ZeroPayout");
        if (address(payoutPolicy) == address(0)) {
            require(msg.sender == owner() || _isProtocolOwner(), "NotFactoryOrProtocol");
        } else {
            require(_isProtocolOwner(), "OnlyProtocol");
        }
        payoutPolicy = IPayoutPolicy(policy_);
        emit PayoutPolicySet(policy_);
    }

    /**
     * @notice Sets or updates the lockup policy.
     * @dev First set allowed by farm owner or ProtocolCore owner; subsequent updates only by ProtocolCore owner.
     * @param policy_ Lockup policy contract address.
     */
    function setLockupPolicy(address policy_) external override {
        require(policy_ != address(0), "ZeroLockup");
        if (address(lockupPolicy) == address(0)) {
            require(msg.sender == owner() || _isProtocolOwner(), "NotFactoryOrProtocol");
        } else {
            require(_isProtocolOwner(), "OnlyProtocol");
        }
        lockupPolicy = ILockupPolicy(policy_);
        emit LockupPolicySet(policy_);
    }

    /**
     * @notice Sets or updates the stakeholder registry.
     * @dev First set allowed by farm owner or ProtocolCore owner; subsequent updates only by ProtocolCore owner.
     * @param registry_ Stakeholder registry contract address.
     */
    function setStakeholderRegistry(address registry_) external override {
        require(registry_ != address(0), "ZeroRegistry");
        if (address(stakeholderRegistry) == address(0)) {
            require(msg.sender == owner() || _isProtocolOwner(), "NotFactoryOrProtocol");
        } else {
            require(_isProtocolOwner(), "OnlyProtocol");
        }
        stakeholderRegistry = IStakeholderRegistry(registry_);
        emit StakeholderRegistrySet(registry_);
    }

    /// @notice Pause deposits/allocations/harvest; withdrawals remain allowed.
    function pause() external override onlyOwner { _pause(); }
    /// @notice Unpause contract operations.
    function unpause() external override onlyOwner { _unpause(); }

    // --- Views ---

    /**
     * @notice Returns the total managed assets (idle + invested via router).
     */
    function totalAssets() public view override returns (uint256) {
        uint256 idle = IERC20(asset).balanceOf(address(this));
        uint256 invested = address(router) == address(0) ? 0 : router.totalAssets();
        return idle + invested;
    }

    /**
     * @notice Converts an asset amount to shares at current price per share.
     * @param assets Asset amount.
     * @return shares Amount of shares.
     */
    function convertToShares(uint256 assets) public view override returns (uint256 shares) {
        uint256 supply = IERC20(address(shareToken)).totalSupply();
        uint256 ta = totalAssets();
        if (supply == 0 || ta == 0) {
            return assets; // 1:1 on first mint
        }
        return (assets * supply) / ta;
    }

    /**
     * @notice Converts a share amount to assets at current price per share.
     * @param shares Share amount.
     * @return assets Amount of assets.
     */
    function convertToAssets(uint256 shares) public view override returns (uint256 assets) {
        uint256 supply = IERC20(address(shareToken)).totalSupply();
        uint256 ta = totalAssets();
        if (supply == 0) return 0;
        return (shares * ta) / supply;
    }

    // --- Core flows ---

    /**
     * @notice Deposit `assets` and mint corresponding `shares` to `receiver`.
     * @dev Assumes non fee-on-transfer tokens; for FOT tokens, actual received may differ.
     * @param assets Asset amount to deposit.
     * @param receiver Address that receives minted shares.
     * @return shares Minted share amount.
     */
    function deposit(uint256 assets, address receiver) external override nonReentrant whenNotPaused returns (uint256 shares) {
        require(assets > 0, "ZeroAssets");
        require(receiver != address(0), "ZeroReceiver");
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

    /**
     * @notice Mint `shares` to `receiver` by depositing the required `assets`.
     * @dev Assumes non fee-on-transfer tokens; for FOT tokens, actual received may differ.
     * @param shares Share amount to mint.
     * @param receiver Address that receives minted shares.
     * @return assets Required assets to deposit.
     */
    function mint(uint256 shares, address receiver) external override nonReentrant whenNotPaused returns (uint256 assets) {
        require(shares > 0, "ZeroShares");
        require(receiver != address(0), "ZeroReceiver");
        assets = convertToAssets(shares);
        require(assets > 0, "ZeroAssets");

        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        if (address(lockupPolicy) != address(0)) {
            lockupPolicy.onDeposit(receiver, assets);
        }
        shareToken.mint(receiver, shares);
    }

    /**
     * @notice Withdraw `assets` to `receiver` by burning corresponding `shares` from `owner_`.
     * @dev Restricted to `owner_` for MVP.
     * @param assets Asset amount to withdraw.
     * @param receiver Recipient of assets.
     * @param owner_ Share owner whose shares are burned.
     * @return shares Shares burned.
     */
    function withdraw(uint256 assets, address receiver, address owner_) external override nonReentrant returns (uint256 shares) {
        require(assets > 0, "ZeroAssets");
        require(receiver != address(0) && owner_ != address(0), "ZeroAddr");
        shares = convertToShares(assets);
        _withdraw(shares, assets, receiver, owner_);
    }

    /**
     * @notice Redeem `shares` from `owner_` and send the resulting `assets` to `receiver`.
     * @dev Restricted to `owner_` for MVP.
     * @param shares Share amount to redeem.
     * @param receiver Recipient of assets.
     * @param owner_ Share owner whose shares are burned.
     * @return assets Assets returned.
     */
    function redeem(uint256 shares, address receiver, address owner_) external override nonReentrant returns (uint256 assets) {
        require(shares > 0, "ZeroShares");
        require(receiver != address(0) && owner_ != address(0), "ZeroAddr");
        assets = convertToAssets(shares);
        _withdraw(shares, assets, receiver, owner_);
    }

    /**
     * @dev Internal withdraw flow shared by `withdraw` and `redeem`.
     * @param shares Shares to burn from `owner_`.
     * @param assetsNeeded Asset amount to return to `receiver`.
     * @param receiver Recipient of assets.
     * @param owner_ Share owner whose shares are burned.
     */
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
            // Deallocate required amount back to this farm
            router.deallocate(shortfall);
            // refresh idle
            idle = IERC20(asset).balanceOf(address(this));
        }
        require(idle >= assetsNeeded, "InsufficientLiquidity");

        uint256 payout = assetsNeeded;
        if (penalty > 0) {
            require(penalty < assetsNeeded, "BadPenalty");
            payout = assetsNeeded - penalty;
            // Penalty remains in farm, effectively benefiting remaining LPs via PPS
        }

        IERC20(asset).safeTransfer(receiver, payout);
    }

    // --- Strategy ops ---

    /**
     * @notice Harvest strategy rewards and stream per payout policy.
     * @return netAssets Net base assets returned from router.harvest().
     */
    function harvest() external override nonReentrant whenNotPaused returns (uint256 netAssets) {
        require(address(router) != address(0), "RouterMissing");
        require(address(payoutPolicy) != address(0), "PayoutMissing");
        // Realize rewards (base asset returned to this farm)
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
        // LP streamed portion is retained in farm as idle (benefits LPs via PPS)

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

        // Report and accrue protocol fee (protocol cut streams as well)
        if (protocolCut > 0) {
            // Report protocol fee contribution to ProtocolCore for lightweight accounting
            IProtocolCoreV3(protocolCore).reportProtocolFee(farmId, protocolCut);
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

    /// @notice Harvest only if `minHarvestInterval` has elapsed.
    /// @return harvested True if a harvest was performed.
    /// @return netAssets Net base assets returned if harvested, else 0.
    function harvestIfNeeded() external whenNotPaused returns (bool harvested, uint256 netAssets) {
        require(address(payoutPolicy) != address(0) && address(router) != address(0), "ModulesMissing");
        IPayoutPolicy.Config memory cfg = payoutPolicy.getConfig();
        uint256 last = payoutPolicy.lastHarvestAt();
        if (block.timestamp < last + cfg.minHarvestInterval) {
            return (false, 0);
        }
        netAssets = this.harvest();
        return (true, netAssets);
    }

    /**
     * @notice Rebalance strategy target allocations via router.
     * @param targetBps Target basis points per adapter id order.
     */
    function rebalance(uint16[] calldata targetBps) external override onlyOwner whenNotPaused {
        require(address(router) != address(0), "RouterMissing");
        router.rebalance(targetBps);
    }

    /// @notice Allocate idle assets to strategies via router according to target bps.
    /// @param amount Asset amount to allocate.
    /// @return deployed Amount deployed by router.
    function allocateToStrategies(uint256 amount) external onlyOwner whenNotPaused returns (uint256 deployed) {
        require(address(router) != address(0), "RouterMissing");
        require(amount > 0, "ZeroAmount");
        IERC20(asset).forceApprove(address(router), 0);
        IERC20(asset).forceApprove(address(router), amount);
        deployed = router.allocate(amount);
    }

    /// @notice Pull assets back from strategies to this farm via router.
    /// @param amount Asset amount to deallocate.
    /// @return received Amount received by the farm.
    function deallocateFromStrategies(uint256 amount) external onlyOwner whenNotPaused returns (uint256 received) {
        require(address(router) != address(0), "RouterMissing");
        require(amount > 0, "ZeroAmount");
        received = router.deallocate(amount);
    }
}
