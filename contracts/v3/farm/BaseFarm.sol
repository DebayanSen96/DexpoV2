// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/IBaseFarm.sol";
import "../interfaces/IStrategyRouter.sol";
import "../interfaces/IPayoutPolicy.sol";
import "../interfaces/ILockupPolicy.sol";
import "../interfaces/IStakeholderRegistry.sol";
import "../interfaces/IShareToken.sol";
import "../interfaces/IPriceOracle.sol";
import "../interfaces/IProtocolCore.sol";

// Minimal interface to read the ProtocolCore owner
interface IHasOwner {
    function owner() external view returns (address);
}

// Minimal interface to read USD prices (1e18) for tokens. Compatible with MockSwapRouter.priceUsdE18(token)
interface IUsdPricer {
    function priceUsdE18(address token) external view returns (uint256);
}

// Optional adapter views for index-style adapters (e.g., BluechipIndexAdapter)
interface IIndexAdapterView {
    function getIndexTokens() external view returns (address[] memory);
    function getTokenInfo(address token) external view returns (bool whitelisted, uint256 tokenBalance);
}
interface IAdapterOracleView { function priceOracle() external view returns (address); }

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

    /// @notice External contract providing USD prices (1e18) for tokens. Example: MockSwapRouter.
    address public usdPricer;

    /// @notice Optional minimum subscription size in base asset units. Default 0 (disabled).
    uint256 public minSubscription;

    /// @notice Emitted when the router is updated.
    event RouterSet(address indexed router);
    /// @notice Emitted when the payout policy is updated.
    event PayoutPolicySet(address indexed policy);
    /// @notice Emitted when the lockup policy is updated.
    event LockupPolicySet(address indexed policy);
    /// @notice Emitted when the stakeholder registry is updated.
    event StakeholderRegistrySet(address indexed registry);
    /// @notice Emitted when the USD pricer is updated.
    event UsdPricerSet(address indexed pricer);
    /// @notice Emitted when minimum subscription size is updated.
    event MinSubscriptionSet(uint256 minAmount);

    /// @notice Parameterless constructor to satisfy Ownable base. Not used by clones.
    constructor() Ownable(msg.sender) {}

    bool private _initialized;

    /**
     * @notice Initialize BaseFarm with an existing share token (e.g., LayerZero OFT) deployed separately.
     * @param asset_ ERC-20 principal token address.
     * @param shareToken_ Address of the pre-deployed share token contract.
     * @param protocolCore_ ProtocolCore contract address.
     * @param farmId_ Unique farm identifier assigned by the protocol.
     * @param initialOwner Owner to assign for admin functions (factory during wiring).
     */
    function initialize(
        address asset_,
        address shareToken_,
        address protocolCore_,
        uint256 farmId_,
        address initialOwner
    ) external {
        require(!_initialized, "Init");
        require(protocolCore_ != address(0) && initialOwner != address(0), "InvalidCoreOrOwner");
        require(shareToken_ != address(0), "ZeroShareToken");
        asset = asset_;
        protocolCore = protocolCore_;
        farmId = farmId_;

        // Wire the external share token
        shareToken = IShareToken(shareToken_);

        _transferOwnership(initialOwner);
        _initialized = true;
    }

    // --- Admin wiring ---

    /// @dev Internal helper: returns true if `msg.sender` is the ProtocolCore owner.
    function _isProtocolOwner() internal view returns (bool) {
        return IHasOwner(protocolCore).owner() == msg.sender;
    }

    /// @dev Allows calls from either the farm owner or the ProtocolCore owner
    modifier onlyOwnerOrProtocolOwner() {
        require(msg.sender == owner() || _isProtocolOwner(), "NotOwnerOrProtocol");
        _;
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

    /**
     * @notice Sets or updates the USD pricer contract used for TVL in USD and PPS in USD.
     * @dev Accepts contracts exposing priceUsdE18(token) like MockSwapRouter. First set allowed by farm or protocol owner; subsequent updates only by protocol owner.
     * @param pricer_ Address of the USD pricer.
     */
    function setUsdPricer(address pricer_) external {
        require(pricer_ != address(0), "ZeroPricer");
        if (usdPricer == address(0)) {
            require(msg.sender == owner() || _isProtocolOwner(), "NotFactoryOrProtocol");
        } else {
            require(_isProtocolOwner(), "OnlyProtocol");
        }
        usdPricer = pricer_;
        emit UsdPricerSet(pricer_);
    }

    /**
     * @notice Set minimum subscription size (in base asset units). 0 disables the check.
     */
    function setMinSubscription(uint256 minAmount) external onlyOwnerOrProtocolOwner {
        minSubscription = minAmount;
        emit MinSubscriptionSet(minAmount);
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
        uint256 idle = asset == address(0)
            ? address(this).balance
            : IERC20(asset).balanceOf(address(this));
        uint256 invested = address(router) == address(0) ? 0 : router.totalAssets();
        return idle + invested;
    }

    /**
     * @notice Returns the total managed assets valued in USD (1e18 USD units).
     * @dev Uses `usdPricer.priceUsdE18(asset)` to convert base-denominated totalAssets() to USD.
     */
    function totalAssetsUsdE18() public view returns (uint256) {
        require(usdPricer != address(0), "UsdPricerMissing");
        uint256 ta = totalAssets();
        if (ta == 0) return 0;
        uint256 pUsd = IUsdPricer(usdPricer).priceUsdE18(asset);
        require(pUsd > 0, "PriceZero");
        uint8 dec = asset == address(0) ? 18 : IERC20Metadata(asset).decimals();
        // USD value = ta * priceUsd / 10**dec(asset)
        return (ta * pUsd) / (10 ** dec);
    }

    /**
     * @notice Converts an asset amount to shares at current price per share.
     * @param assets Asset amount.
     * @return shares Amount of shares.
     */
    function convertToShares(uint256 assets) public view override returns (uint256 shares) {
        uint256 supply = IERC20(address(shareToken)).totalSupply();
        uint256 ta = totalAssets();
        if (supply == 0) {
            return assets; // 1:1 on first mint only
        }
        require(ta > 0, "NAVZero");
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

    /**
     * @notice Price per share in base asset units, scaled to 1e18.
     */
    function pricePerShareE18() external view returns (uint256) {
        uint256 supply = IERC20(address(shareToken)).totalSupply();
        if (supply == 0) return 1e18; // bootstrap
        uint256 ta = totalAssets();
        return (ta * 1e18) / supply;
    }

    /**
     * @notice Price per share in USD (1e18 USD units).
     */
    function pricePerShareUsdE18() external view returns (uint256) {
        uint256 supply = IERC20(address(shareToken)).totalSupply();
        if (supply == 0) return 1e18; // treat initial PPS as $1 if base is $1; mostly for UI
        require(usdPricer != address(0), "UsdPricerMissing");
        uint256 ppsBaseE18 = (totalAssets() * 1e18) / supply;
        uint256 pUsd = IUsdPricer(usdPricer).priceUsdE18(asset);
        require(pUsd > 0, "PriceZero");
        uint8 dec = asset == address(0) ? 18 : IERC20Metadata(asset).decimals();
        // Convert base-denominated PPS to USD: (ppsBase * priceUsd) / 10**dec(asset)
        return (ppsBaseE18 * pUsd) / (10 ** dec);
    }

    // --- Allocation and holdings views ---

    /**
     * @notice Returns current router allocations: adapter ids, addresses, and target bps.
     */
    function getAllocations() external view returns (
        bytes32[] memory ids,
        address[] memory adapters,
        uint16[] memory bps
    ) {
        require(address(router) != address(0), "RouterMissing");
        return router.allocations();
    }

    /**
     * @notice Best-effort snapshot of adapter token holdings and base-equivalent values.
     * @dev For adapters that implement {getIndexTokens,getTokenInfo} and optionally {priceOracle()},
     *      returns token lists, raw balances, and estimated base amounts using IPriceOracle(oracle).quote.
     *      Adapters not supporting these views will return empty arrays.
     * @return adapters The adapter addresses from router.allocations().
     * @return tokensPerAdapter tokensPerAdapter[i] is the token list held by adapters[i].
     * @return balancesPerAdapter balancesPerAdapter[i][j] is raw token balance of tokensPerAdapter[i][j].
     * @return basePerAdapter basePerAdapter[i][j] is estimated base amount via oracle (0 if unavailable).
     */
    function getAdapterHoldings()
        external
        view
        returns (
            address[] memory adapters,
            address[][] memory tokensPerAdapter,
            uint256[][] memory balancesPerAdapter,
            uint256[][] memory basePerAdapter
        )
    {
        require(address(router) != address(0), "RouterMissing");
        (, adapters, ) = router.allocations();
        uint256 n = adapters.length;
        tokensPerAdapter = new address[][](n);
        balancesPerAdapter = new uint256[][](n);
        basePerAdapter = new uint256[][](n);

        for (uint256 i = 0; i < n; i++) {
            address ad = adapters[i];
            address[] memory toks;
            // Try to read index token set
            try IIndexAdapterView(ad).getIndexTokens() returns (address[] memory ts) {
                toks = ts;
            } catch {
                toks = new address[](0);
            }
            tokensPerAdapter[i] = toks;
            uint256 m = toks.length;
            uint256[] memory bals = new uint256[](m);
            uint256[] memory bases = new uint256[](m);

            address oracle = address(0);
            // Try to read adapter price oracle (optional)
            if (m > 0) {
                try IAdapterOracleView(ad).priceOracle() returns (address po) {
                    oracle = po;
                } catch {}
            }

            for (uint256 j = 0; j < m; j++) {
                ( , uint256 bal) = IIndexAdapterView(ad).getTokenInfo(toks[j]);
                bals[j] = bal;
                if (oracle != address(0) && toks[j] != asset && bal > 0) {
                    try IPriceOracle(oracle).quote(toks[j], asset, bal) returns (uint256 baseAmt) {
                        bases[j] = baseAmt;
                    } catch {
                        bases[j] = 0;
                    }
                } else if (toks[j] == asset) {
                    bases[j] = bal;
                }
            }
            balancesPerAdapter[i] = bals;
            basePerAdapter[i] = bases;
        }
    }

    // --- Core flows ---

    /**
     * @notice Deposit `assets` and mint corresponding `shares` to msg.sender.
     * @dev Assumes non fee-on-transfer tokens; for FOT tokens, actual received may differ.
     * @param assets Asset amount to deposit.
     * @return shares Minted share amount.
     */
    function deposit(uint256 assets) external payable override nonReentrant whenNotPaused returns (uint256 shares) {
        require(assets > 0, "ZeroAssets");
        if (minSubscription > 0) require(assets >= minSubscription, "MinSub");
        shares = convertToShares(assets);
        require(shares > 0, "ZeroShares");

        if (asset == address(0)) {
            require(msg.value == assets, "BadEthValue");
        } else {
            IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        }

        // lockup hook
        if (address(lockupPolicy) != address(0)) {
            lockupPolicy.onDeposit(msg.sender, assets);
        }

        // mint shares to sender
        shareToken.mint(msg.sender, shares);
    }

    /**
     * @notice Mint `shares` to msg.sender by depositing the required `assets`.
     * @dev Assumes non fee-on-transfer tokens; for FOT tokens, actual received may differ.
     * @param shares Share amount to mint.
     * @return assets Required assets to deposit.
     */
    function mint(uint256 shares) external payable override nonReentrant whenNotPaused returns (uint256 assets) {
        require(shares > 0, "ZeroShares");
        assets = convertToAssets(shares);
        require(assets > 0, "ZeroAssets");
        if (minSubscription > 0) require(assets >= minSubscription, "MinSub");

        if (asset == address(0)) {
            require(msg.value == assets, "BadEthValue");
        } else {
            IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        }
        if (address(lockupPolicy) != address(0)) {
            lockupPolicy.onDeposit(msg.sender, assets);
        }
        shareToken.mint(msg.sender, shares);
    }

    /**
     * @notice Partially exit by specifying share amount to burn.
     * @param shares Share amount to burn.
     * @return assets Assets returned to msg.sender based on current PPS.
     */
    function withdrawShares(uint256 shares) external nonReentrant returns (uint256 assets) {
        require(shares > 0, "ZeroShares");
        assets = convertToAssets(shares);
        require(assets > 0, "ZeroAssets");
        _withdraw(shares, assets);
    }

    /**
     * @notice Fully exit position: burn all shares held by msg.sender and receive all corresponding assets.
     * @return assets Assets returned to msg.sender.
     */
    function fullExit() external override nonReentrant returns (uint256 assets) {
        uint256 shares = IERC20(address(shareToken)).balanceOf(msg.sender);
        require(shares > 0, "NoShares");
        assets = convertToAssets(shares);
        require(assets > 0, "ZeroAssets");
        _withdraw(shares, assets);
    }

    /**
     * @dev Internal withdraw flow shared by `withdrawShares` and `fullExit`.
     * @param shares Shares to burn from msg.sender.
     * @param assetsNeeded Asset amount to return to msg.sender.
     */
    function _withdraw(uint256 shares, uint256 assetsNeeded) internal {
        // Burn caller's shares
        shareToken.burn(msg.sender, shares);

        // Apply lockup and penalty
        uint256 penalty = 0;
        if (address(lockupPolicy) != address(0)) {
            penalty = lockupPolicy.enforceWithdrawal(msg.sender, assetsNeeded);
        }

        // Ensure liquidity: if idle < assetsNeeded, pull back from strategies via router
        uint256 idle = asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
        if (idle < assetsNeeded) {
            require(address(router) != address(0), "RouterMissing");
            uint256 shortfall = assetsNeeded - idle;
            // Deallocate required amount back to this farm
            router.deallocate(shortfall);
            // refresh idle
            idle = asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
        }
        require(idle >= assetsNeeded, "InsufficientLiquidity");

        uint256 payout = assetsNeeded;
        if (penalty > 0) {
            require(penalty < assetsNeeded, "BadPenalty");
            payout = assetsNeeded - penalty;
            // Penalty remains in farm, effectively benefiting remaining LPs via PPS
        }

        if (asset == address(0)) {
            (bool ok, ) = payable(msg.sender).call{value: payout}("");
            require(ok, "EthSendFail");
        } else {
            IERC20(asset).safeTransfer(msg.sender, payout);
        }
    }

    // --- User position view ---
    /**
     * @notice Returns a snapshot of a user's position in the farm.
     * @param account The address to query.
     * @return shares Balance of farm share token held by `account`.
     * @return assets Current equivalent asset value for `shares`.
     * @return claimableRewards Claimable rewards according to `payoutPolicy` (0 if none).
     * @return lockStart Lock start timestamp from `lockupPolicy` (0 if not applicable).
     * @return lockEnd Lock end timestamp from `lockupPolicy` (0 if not applicable).
     * @return locked True if currently locked according to `lockupPolicy`.
     */
    function getUserPosition(address account)
        external
        view
        override
        returns (
            uint256 shares,
            uint256 assets,
            uint256 claimableRewards,
            uint64 lockStart,
            uint64 lockEnd,
            bool locked
        )
    {
        shares = IERC20(address(shareToken)).balanceOf(account);
        assets = convertToAssets(shares);
        claimableRewards = address(payoutPolicy) == address(0) ? 0 : payoutPolicy.claimable(account);
        if (address(lockupPolicy) != address(0)) {
            (lockStart, lockEnd, locked) = lockupPolicy.lockInfo(account);
        }
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
            // 100% compound case: stakeholders should still accrue their fee split
            _accrueStakeholderFees(netAssets);
            // Remaining yield stays in farm (idle/strategies), benefiting LPs via PPS
            return netAssets;
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
        uint256 transferAmt = ownerNet + protocolCut + verifierAmt;
        if (asset == address(0)) {
            (bool ok, ) = payable(address(payoutPolicy)).call{value: transferAmt}("");
            require(ok, "EthTransferFail");
        } else {
            IERC20(asset).safeTransfer(address(payoutPolicy), transferAmt);
        }

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

    /// @dev Accrue stakeholder fees (owner, verifiers, protocol rake) from a gross harvested amount.
    ///      Transfers the fee tokens to the payout policy and schedules streams for beneficiaries.
    function _accrueStakeholderFees(uint256 gross) internal {
        if (gross == 0) return;
        require(address(stakeholderRegistry) != address(0), "RegistryMissing");

        IStakeholderRegistry.Splits memory s = stakeholderRegistry.getSplits();
        uint256 ownerAmt_ = (gross * s.ownerBps) / 10_000;
        uint256 verifierAmt_ = (gross * s.verifierBps) / 10_000;

        // Protocol rake from the owner portion
        address protocolReceiver_ = shareToken.protocolFeeReceiver();
        uint16 protocolRakeBps_ = shareToken.protocolRakeBps();
        uint256 protocolCut_ = protocolReceiver_ == address(0) ? 0 : (ownerAmt_ * protocolRakeBps_) / 10_000;
        uint256 ownerNet_ = ownerAmt_ - protocolCut_;

        // Transfer fee funds to policy custody
        uint256 transferAmt = ownerNet_ + protocolCut_ + verifierAmt_;
        if (transferAmt > 0) {
            if (asset == address(0)) {
                (bool ok, ) = payable(address(payoutPolicy)).call{value: transferAmt}("");
                require(ok, "EthTransferFail");
            } else {
                IERC20(asset).safeTransfer(address(payoutPolicy), transferAmt);
            }
        }

        // Accrue for owner
        address ownerRecipient_ = stakeholderRegistry.ownerRecipient();
        if (ownerNet_ > 0 && ownerRecipient_ != address(0)) {
            payoutPolicy.accrueFor(ownerRecipient_, ownerNet_);
        }

        // Accrue protocol fee and report
        if (protocolCut_ > 0) {
            IProtocolCoreV3(protocolCore).reportProtocolFee(farmId, protocolCut_);
            payoutPolicy.accrueFor(protocolReceiver_, protocolCut_);
        }

        // Accrue for verifiers
        if (verifierAmt_ > 0) {
            address[] memory verifiers_ = stakeholderRegistry.activeVerifiers();
            uint256 n = verifiers_.length;
            if (n > 0) {
                uint256 each_ = verifierAmt_ / n;
                uint256 remainder_ = verifierAmt_ - (each_ * n);
                for (uint256 i = 0; i < n; i++) {
                    if (each_ > 0) payoutPolicy.accrueFor(verifiers_[i], each_);
                }
                if (remainder_ > 0 && ownerRecipient_ != address(0)) {
                    payoutPolicy.accrueFor(ownerRecipient_, remainder_);
                }
            }
        }
    }

    // --- Claims ---
    /**
     * @notice View the amount of streamed rewards currently claimable for `account`.
     * @dev Denominated in the farm's base asset. Returns 0 if no payout policy configured.
     */
    function claimable(address account) external view returns (uint256) {
        if (address(payoutPolicy) == address(0)) return 0;
        return payoutPolicy.claimable(account);
    }

    /**
     * @notice Claim streamed rewards for msg.sender and send them to `to`.
     * @dev Pulls from the payout policy contract which holds the streamed funds in base asset.
     * @return amount Amount claimed in base asset units.
     */
    function claimRewards(address to) external whenNotPaused returns (uint256 amount) {
        require(address(payoutPolicy) != address(0), "PayoutMissing");
        require(to != address(0), "ZeroTo");
        amount = payoutPolicy.claim(to);
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
    function allocateToStrategies(uint256 amount) external whenNotPaused onlyOwnerOrProtocolOwner returns (uint256 deployed) {
        require(address(router) != address(0), "RouterMissing");
        require(amount > 0, "ZeroAmount");
        if (asset == address(0)) {
            require(address(this).balance >= amount, "InsufficientBalance");
            deployed = router.allocate{value: amount}(amount);
        } else {
            IERC20(asset).forceApprove(address(router), 0);
            IERC20(asset).forceApprove(address(router), amount);
            deployed = router.allocate(amount);
        }
    }

    /// @notice Pull assets back from strategies to this farm via router.
    /// @param amount Asset amount to deallocate.
    /// @return received Amount received by the farm.
    function deallocateFromStrategies(uint256 amount) external onlyOwner whenNotPaused returns (uint256 received) {
        require(address(router) != address(0), "RouterMissing");
        require(amount > 0, "ZeroAmount");
        received = router.deallocate(amount);
    }

    /// @notice Accept ETH for native ETH farms (from router deallocate, harvest, etc.)
    receive() external payable {
        require(asset == address(0), "NotNativeETHFarm");
    }
}
