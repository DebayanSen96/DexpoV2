// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ICoreAccessControlLike {
    function isGlobalPaused() external view returns (bool);
    function isVaultPaused(address vault) external view returns (bool);
    function canOperate(address vault, address operator) external view returns (bool);
}

// Minimal interface to read owner of the core contract (protocol owner)
interface IOwnableMinimal {
    function owner() external view returns (address);
}

interface IVaultLike {
    function asset() external view returns (address);
}

interface IAssetsValuer {
    function assetsOfVault(address asset, address vault) external view returns (uint256);
}

interface IMockSwapRouter {
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
    function swapFrom(address tokenIn, address tokenOut, uint256 amountIn, address from, address recipient) external returns (uint256 amountOut);
    function priceUsdE18(address token) external view returns (uint256);
}

contract VaultTreasury is Ownable, IAssetsValuer {
    using SafeERC20 for IERC20;

    // Immutable wiring
    address public immutable core;      // Protocol core for operator checks
    address public immutable baseAsset; // Vault base asset

    // Mutable wiring
    address public vault;               // bound once post-vault creation
    address public router;              // mock swap router (testnet)

    // Tracked tokens held as external positions (including base if desired)
    mapping(address => bool) public isTracked;
    address[] public trackedTokens;

    // Simulated lending/borrowing state (base units)
    uint256 public lendPrincipal;       // base lent (principal only)
    uint256 public borrowPrincipal;     // base borrowed (principal only)
    uint256 public lastAccrualTs;       // timestamp of last accrual baseline
    uint256 public lendAprBps;          // e.g. 500 = 5% APR
    uint256 public borrowAprBps;        // e.g. 800 = 8% APR

    // Cached USD metrics (1e18 scaling)
    uint256 public lastTvlUsdE18;
    uint256 public lastIdleUsdE18;
    uint256 public lastInvestedUsdE18;

    event VaultBound(address vault);
    event RouterSet(address router);
    event RatesSet(uint256 lendAprBps, uint256 borrowAprBps);
    event Lent(uint256 amount);
    event Repaid(uint256 amount);
    event Borrowed(uint256 amount);
    event SwapExecuted(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event ReturnedToVault(uint256 amount);
    event UsdSnapshot(uint256 tvlUsdE18, uint256 idleUsdE18, uint256 investedUsdE18);

    error NotVaultOrOperator();
    error AlreadyBound();
    error ZeroAddress();

    modifier onlyVaultOrOperator() {
        if (msg.sender == vault) {
            _;
        } else {
            if (!ICoreAccessControlLike(core).canOperate(vault, msg.sender) && msg.sender != core) revert NotVaultOrOperator();
            _;
        }
    }

    constructor(address _core, address _ownerEoa, address _baseAsset, address _router) Ownable(_ownerEoa) {
        if (_core == address(0) || _ownerEoa == address(0) || _baseAsset == address(0)) revert ZeroAddress();
        core = _core;
        baseAsset = _baseAsset;
        router = _router;
        lastAccrualTs = block.timestamp;
        // Track base by default for convenience
        _trackToken(_baseAsset);
    }

    function setVaultOnce(address v) external {
        if (v == address(0)) revert ZeroAddress();
        if (vault != address(0)) revert AlreadyBound();
        
        // Allow treasury owner OR protocol owner (core owner) to set vault
        bool isOwner = msg.sender == owner();
        bool isProtocolOwner = false;
        
        if (!isOwner && core != address(0)) {
            // Best-effort query of core owner (protocol owner); ignore failure
            try IOwnableMinimal(core).owner() returns (address coreOwner) {
                isProtocolOwner = (msg.sender == coreOwner);
            } catch {
                // If query fails, isProtocolOwner remains false
            }
        }
        
        require(isOwner || isProtocolOwner, "Ownable: caller is not the owner");
        
        vault = v;
        emit VaultBound(v);
        _recalcAndCacheUsd();
    }

    function setRouter(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        router = r;
        emit RouterSet(r);
        _recalcAndCacheUsd();
    }

    function setRates(uint256 _lendAprBps, uint256 _borrowAprBps) external onlyOwner {
        lendAprBps = _lendAprBps;
        borrowAprBps = _borrowAprBps;
        emit RatesSet(_lendAprBps, _borrowAprBps);
        _recalcAndCacheUsd();
    }

    // ---------------- Assets Valuation ----------------
    function assetsOfVault(address asset_, address vault_) external view override returns (uint256) {
        if (vault_ != vault || asset_ != baseAsset) return 0; // only value our bound vault/base
        // Accrued values
        (uint256 lendAccrued, uint256 borrowAccrued) = _accrued();

        // Sum all tracked token balances converted to base using router quotes.
        uint256 externalTotalBase = 0;
        for (uint256 i = 0; i < trackedTokens.length; i++) {
            address t = trackedTokens[i];
            uint256 bal = IERC20(t).balanceOf(address(this));
            if (bal == 0) continue;
            if (t == baseAsset) {
                // Exclude the lent principal portion from base balance to avoid double counting.
                // Any remaining base in Treasury counts as external idle (deployed but not lent).
                uint256 effective = bal;
                if (lendPrincipal < effective) {
                    effective = effective - lendPrincipal;
                } else {
                    effective = 0;
                }
                externalTotalBase += effective;
            } else {
                if (router != address(0)) {
                    uint256 inBase = IMockSwapRouter(router).quote(t, baseAsset, bal);
                    externalTotalBase += inBase;
                } else {
                    // No router -> cannot convert; treat as zero for safety
                }
            }
        }

        // Combine: holdings (converted) + lending interest - borrowing cost + lent principal (accrued is principal+interest)
        // Note: externalTotalBase already excluded the lent principal from base holdings; so add full lendAccrued and subtract full borrowAccrued.
        if (borrowAccrued > externalTotalBase + lendAccrued) {
            // floor at zero to avoid underflow; negative NAVs clamp to zero for this mock
            return 0;
        }
        return externalTotalBase + lendAccrued - borrowAccrued;
    }

    function trackedTokenCount() external view returns (uint256) { return trackedTokens.length; }
    function trackToken(address t) external onlyVaultOrOperator { _trackToken(t); }
    function getCachedUsd() external view returns (uint256 tvlUsdE18, uint256 idleUsdE18, uint256 investedUsdE18) { return (lastTvlUsdE18, lastIdleUsdE18, lastInvestedUsdE18); }

    // ---------------- Strategy Actions (called via Vault.executeAction) ----------------

    function swapBaseToToken(address tokenOut, uint256 amountInBase) external onlyVaultOrOperator returns (uint256 amountOut) {
        _ensureApprove(baseAsset, router, amountInBase);
        amountOut = IMockSwapRouter(router).swapFrom(baseAsset, tokenOut, amountInBase, vault, address(this));
        _trackToken(tokenOut);
        emit SwapExecuted(baseAsset, tokenOut, amountInBase, amountOut);
        _recalcAndCacheUsd();
    }

    function swapTokenToBase(address tokenIn, uint256 amountInToken) external onlyVaultOrOperator returns (uint256 amountOut) {
        _ensureApprove(tokenIn, router, amountInToken);
        amountOut = IMockSwapRouter(router).swapFrom(tokenIn, baseAsset, amountInToken, address(this), address(this));
        _trackToken(baseAsset);
        emit SwapExecuted(tokenIn, baseAsset, amountInToken, amountOut);
        _recalcAndCacheUsd();
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn) external onlyVaultOrOperator returns (uint256 amountOut) {
        _ensureApprove(tokenIn, router, amountIn);
        amountOut = IMockSwapRouter(router).swapFrom(tokenIn, tokenOut, amountIn, address(this), address(this));
        _trackToken(tokenOut);
        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
        _recalcAndCacheUsd();
    }

    // Alias for spot buy/sell simulations (inline to avoid forward-reference lints)
    function buyToken(address tokenOut, uint256 amountBase) external onlyVaultOrOperator returns (uint256 amountOut) {
        _ensureApprove(baseAsset, router, amountBase);
        amountOut = IMockSwapRouter(router).swapFrom(baseAsset, tokenOut, amountBase, vault, address(this));
        _trackToken(tokenOut);
        emit SwapExecuted(baseAsset, tokenOut, amountBase, amountOut);
        _recalcAndCacheUsd();
    }

    function sellToken(address tokenIn, uint256 amountToken) external onlyVaultOrOperator returns (uint256 amountOut) {
        _ensureApprove(tokenIn, router, amountToken);
        amountOut = IMockSwapRouter(router).swapFrom(tokenIn, baseAsset, amountToken, address(this), address(this));
        _trackToken(baseAsset);
        emit SwapExecuted(tokenIn, baseAsset, amountToken, amountOut);
        _recalcAndCacheUsd();
    }

    // Simulated lending/borrowing
    function lendBase(uint256 amountBase) external onlyVaultOrOperator {
        // Pull base from vault into Treasury to mark it as deployed capital
        IERC20(baseAsset).safeTransferFrom(vault, address(this), amountBase);
        // Increase lent principal; valuation excludes this from base balance and adds accrued lend value
        lendPrincipal += amountBase;
        _updateAccrualBaseline();
        emit Lent(amountBase);
        _recalcAndCacheUsd();
    }

    function repayLend(uint256 amountBase) external onlyVaultOrOperator {
        if (amountBase > lendPrincipal) amountBase = lendPrincipal;
        lendPrincipal -= amountBase;
        _updateAccrualBaseline();
        emit Repaid(amountBase);
        _recalcAndCacheUsd();
    }

    function borrowBase(uint256 amountBase) external onlyVaultOrOperator {
        borrowPrincipal += amountBase;
        _updateAccrualBaseline();
        emit Borrowed(amountBase);
        _recalcAndCacheUsd();
    }

    function repayBorrow(uint256 amountBase) external onlyVaultOrOperator {
        if (amountBase > borrowPrincipal) amountBase = borrowPrincipal;
        borrowPrincipal -= amountBase;
        _updateAccrualBaseline();
        emit Repaid(amountBase);
        _recalcAndCacheUsd();
    }

    function returnBaseToVault(uint256 amount) external onlyVaultOrOperator {
        uint256 bal = IERC20(baseAsset).balanceOf(address(this));
        uint256 sendable = amount < bal ? amount : bal;
        if (sendable == 0) return;
        uint256 nonLent = bal > lendPrincipal ? bal - lendPrincipal : 0;
        uint256 fromNonLent = sendable < nonLent ? sendable : nonLent;
        if (fromNonLent > 0) {
            IERC20(baseAsset).safeTransfer(vault, fromNonLent);
        }
        uint256 remaining = sendable - fromNonLent;
        if (remaining > 0) {
            IERC20(baseAsset).safeTransfer(vault, remaining);
            uint256 repayLendAmt = remaining < lendPrincipal ? remaining : lendPrincipal;
            if (repayLendAmt > 0) {
                lendPrincipal -= repayLendAmt;
                _updateAccrualBaseline();
            }
        }
        emit ReturnedToVault(sendable);
        _recalcAndCacheUsd();
    }

    // ---------------- Internal helpers ----------------

    function _trackToken(address t) internal {
        if (!isTracked[t]) {
            isTracked[t] = true;
            trackedTokens.push(t);
        }
    }

    function _ensureApprove(address token, address spender, uint256 amount) internal {
        if (spender == address(0)) return;
        uint256 al = IERC20(token).allowance(address(this), spender);
        if (al < amount) {
            IERC20(token).forceApprove(spender, 0);
            IERC20(token).forceApprove(spender, type(uint256).max);
        }
    }

    function _accrued() internal view returns (uint256 lendAccrued, uint256 borrowAccrued) {
        uint256 dt = block.timestamp - lastAccrualTs;
        uint256 year = 365 days;
        lendAccrued = lendPrincipal + (lendPrincipal * lendAprBps * dt) / (year * 10000);
        borrowAccrued = borrowPrincipal + (borrowPrincipal * borrowAprBps * dt) / (year * 10000);
    }

    function _updateAccrualBaseline() internal {
        lastAccrualTs = block.timestamp;
    }

    function _priceUsdE18(address token) internal view returns (uint256) {
        if (router == address(0)) return 0;
        return IMockSwapRouter(router).priceUsdE18(token);
    }

    function _toUsdE18(address token, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        uint256 p = _priceUsdE18(token);
        if (p == 0) return 0;
        uint8 d = IERC20Metadata(token).decimals();
        return (amount * p) / (10 ** d);
    }

    function _recalcAndCacheUsd() internal {
        uint256 idleBase = IERC20(baseAsset).balanceOf(vault);
        uint256 idleUsd = _toUsdE18(baseAsset, idleBase);

        uint256 holdingsUsd = 0;
        for (uint256 i = 0; i < trackedTokens.length; i++) {
            address t = trackedTokens[i];
            uint256 bal = IERC20(t).balanceOf(address(this));
            if (bal == 0) continue;
            if (t == baseAsset) {
                uint256 effective = bal;
                if (lendPrincipal < effective) { effective = effective - lendPrincipal; } else { effective = 0; }
                holdingsUsd += _toUsdE18(baseAsset, effective);
            } else {
                holdingsUsd += _toUsdE18(t, bal);
            }
        }

        (uint256 lendAccrued, uint256 borrowAccrued) = _accrued();
        uint256 netAccruedUsd = 0;
        uint256 lendUsd = _toUsdE18(baseAsset, lendAccrued);
        uint256 borrowUsd = _toUsdE18(baseAsset, borrowAccrued);
        if (lendUsd > borrowUsd) netAccruedUsd = lendUsd - borrowUsd; else netAccruedUsd = 0;

        uint256 investedUsd = holdingsUsd + netAccruedUsd;
        uint256 tvlUsd = idleUsd + investedUsd;

        lastIdleUsdE18 = idleUsd;
        lastInvestedUsdE18 = investedUsd;
        lastTvlUsdE18 = tvlUsd;
        emit UsdSnapshot(tvlUsd, idleUsd, investedUsd);
    }
}
