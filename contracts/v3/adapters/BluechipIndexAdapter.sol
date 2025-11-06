// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategyAdapter.sol";
import "../interfaces/IOwnable.sol";
import "../interfaces/IWhitelistRegistry.sol";
import "../interfaces/IPriceOracle.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title BluechipIndexAdapter (Simplified)
 * @notice Router-controlled adapter that simply holds multiple assets.
 *         Swaps require dual signatures: farm owner + protocol owner (EIP-712).
 *         Withdrawals sell to base via whitelisted 0x target.
 */
interface IMockSwapRouter {
    function swapFrom(address tokenIn, address tokenOut, uint256 amountIn, address from, address recipient) external returns (uint256);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

contract BluechipIndexAdapter is IStrategyAdapter, Ownable, EIP712 {
    using SafeERC20 for IERC20;

    address public immutable override asset;
    address public protocolCore;
    address public router;
    bool public routerSet;

    address public whitelistRegistry;
    address public swapTarget; // 0x Exchange Proxy or other whitelisted target
    address public priceOracle; // optional price oracle for NAV valuation

    address[] public indexTokens;
    mapping(address => bool) public isWhitelisted;

    // EIP-712 domain and swap struct
    bytes32 private constant SWAP_TYPEHASH = keccak256(
        "Swap(address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,bytes data,uint256 deadline,uint256 nonce)"
    );
    // EIP-712 approval struct for dual-signature token approvals (simplified: no deadline/nonce)
    bytes32 private constant APPROVAL_TYPEHASH = keccak256(
        "Approval(address token,address spender,uint256 amount)"
    );
    uint256 public nonce;
    bytes4 private constant EIP1271_MAGICVALUE = 0x1626ba7e;

    // Events
    event RouterSet(address indexed router);
    event WhitelistRegistrySet(address indexed registry);
    event SwapTargetSet(address indexed swapTarget);
    event TokensAdded(address[] tokens);
    event TokenRemoved(address indexed token);
    event SwapExecuted(address indexed sellToken, uint256 sellAmount, address indexed buyToken, uint256 buyAmount);
    event WithdrawSellExecuted(address indexed token, uint256 tokenIn, uint256 baseOut);
    event ApprovalGranted(address indexed token, address indexed spender, uint256 amount, address indexed caller);
    event PriceOracleSet(address indexed oracle);

    error NotRouter();
    error NotWhitelisted();
    error InvalidSignature();
    error Expired();
    error InvalidTarget();
    error InvalidToken();
    error NotOwnerOrRouterOwner();
    error NotFarmOrProtocolOwner();
    error NotProtocolOwner();

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier onlyProtocolOwner() {
        if (msg.sender != IOwnable(protocolCore).owner()) revert NotProtocolOwner();
        _;
    }

    modifier onlyOwnerOrRouterOwner() {
        address routerOwner = IOwnable(router).owner();
        if (msg.sender != owner() && msg.sender != routerOwner) revert NotOwnerOrRouterOwner();
        _;
    }

    modifier onlyFarmOrProtocolOwner() {
        address farmOwner = address(0);
        if (router != address(0)) {
            farmOwner = IOwnable(router).owner();
        }
        address protocolOwner = IOwnable(protocolCore).owner();
        if (msg.sender != farmOwner && msg.sender != protocolOwner) revert NotFarmOrProtocolOwner();
        _;
    }

    constructor(
        address asset_,
        address protocolCore_,
        address swapTarget_,
        address[] memory tokens_
    ) Ownable(msg.sender) EIP712("BluechipIndexAdapter", "1") {
        // asset_ may be address(0) to indicate native ETH
        require(protocolCore_ != address(0), "AddrZero");
        require(swapTarget_ != address(0), "TargetZero");
        asset = asset_;
        protocolCore = protocolCore_;
        swapTarget = swapTarget_;
        // Default oracle to the swap target (mock router exposes quote())
        priceOracle = swapTarget_;
        emit SwapTargetSet(swapTarget_);
        emit PriceOracleSet(priceOracle);
        if (tokens_.length > 0) {
            _addTokens(tokens_);
        }
    }

    // Admin
    function setRouterOnce(address r) external {
        require(!routerSet, "RouterSet");
        require(r != address(0), "Zero");
        address coreOwner = IOwnable(protocolCore).owner();
        require(
            msg.sender == protocolCore ||
            msg.sender == coreOwner ||
            msg.sender == IOwnable(r).owner(),
            "Unauthorized"
        );
        router = r;
        routerSet = true;
        emit RouterSet(r);
    }

    function setWhitelistRegistry(address r) external {
        require(r != address(0), "Zero");
        address coreOwner = IOwnable(protocolCore).owner();
        require(msg.sender == protocolCore || msg.sender == coreOwner, "Unauthorized");
        whitelistRegistry = r;
        emit WhitelistRegistrySet(r);
    }

    function setPriceOracle(address o) external onlyOwner {
        require(o != address(0), "Zero");
        priceOracle = o;
        emit PriceOracleSet(o);
    }

    function setSwapTarget(address t) external onlyOwner {
        require(t != address(0), "Zero");
        swapTarget = t;
        // Keep oracle aligned with swap target unless explicitly changed via setPriceOracle
        priceOracle = t;
        emit SwapTargetSet(t);
        emit PriceOracleSet(t);
    }

    function addTokens(address[] calldata tokens_) external onlyOwner {
        _addTokens(tokens_);
    }

    function removeToken(address token) external onlyOwner {
        require(isWhitelisted[token], "NotListed");
        uint256 n = indexTokens.length;
        for (uint256 i = 0; i < n; i++) {
            if (indexTokens[i] == token) {
                indexTokens[i] = indexTokens[n - 1];
                indexTokens.pop();
                break;
            }
        }
        delete isWhitelisted[token];
        emit TokenRemoved(token);
    }

    // Dual-sig swap
    function authorizedSwap(
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minBuyAmount,
        bytes calldata data,
        uint256 deadline,
        bytes calldata farmSig,
        bytes calldata protocolSig
    ) external {
        require(block.timestamp <= deadline, "Expired");
        // Allow native ETH represented by address(0)
        require(
            (sellToken == address(0) || isWhitelisted[sellToken]) &&
            (buyToken == asset || buyToken == address(0) || isWhitelisted[buyToken]),
            "InvalidToken"
        );
        require(swapTarget != address(0), "InvalidTarget");

        bytes32 structHash = keccak256(
            abi.encode(
                SWAP_TYPEHASH,
                sellToken,
                buyToken,
                sellAmount,
                minBuyAmount,
                keccak256(data),
                deadline,
                nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        address farmOwner = IOwnable(router).owner();
        address protocolOwner = IOwnable(protocolCore).owner();

        require(_isValidSig(farmOwner, digest, farmSig), "InvalidSignature");
        require(_isValidSig(protocolOwner, digest, protocolSig), "InvalidSignature");
        nonce++;

        uint256 buyBefore = buyToken == address(0)
            ? address(this).balance
            : IERC20(buyToken).balanceOf(address(this));

        uint256 callValue = 0;
        if (sellToken == address(0)) {
            // selling native ETH
            callValue = sellAmount;
        } else {
            // selling ERC20
            IERC20(sellToken).forceApprove(swapTarget, 0);
            IERC20(sellToken).forceApprove(swapTarget, sellAmount);
        }

        (bool success,) = swapTarget.call{value: callValue}(data);
        require(success, "SwapFailed");
        uint256 buyAfter = buyToken == address(0)
            ? address(this).balance
            : IERC20(buyToken).balanceOf(address(this));
        uint256 buyAmount = buyAfter - buyBefore;
        require(buyAmount >= minBuyAmount, "Slippage");

        emit SwapExecuted(sellToken, sellAmount, buyToken, buyAmount);
    }

    function _isValidSig(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            if (signature.length != 65) return false;
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            // Reject malleable 's' values: s must be in lower half order
            if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return false;
            // Only allow v 27/28
            if (v != 27 && v != 28) return false;
            address rec = ecrecover(digest, v, r, s);
            return rec == signer;
        } else {
            // Contract wallet: verify the same EIP-712 digest via EIP-1271 (domain binds to this contract & chainId)
            try IERC1271(signer).isValidSignature(digest, signature) returns (bytes4 magic) {
                return magic == EIP1271_MAGICVALUE;
            } catch {
                return false;
            }
        }
    }

    // IStrategyAdapter
    function deposit(uint256 amount, bytes calldata) external payable override onlyRouter returns (uint256) {
        if (asset == address(0)) {
            require(msg.value == amount, "BadETH");
            // ETH received in contract balance
            return amount;
        } else {
            IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
            return amount;
        }
    }

    function withdraw(uint256 amount, bytes calldata data) external override onlyRouter returns (uint256 received) {
        uint256 baseBal = asset == address(0)
            ? address(this).balance
            : IERC20(asset).balanceOf(address(this));

        if (baseBal >= amount) {
            if (asset == address(0)) {
                (bool s,) = payable(msg.sender).call{value: amount}("");
                require(s, "ETHSendFail");
            } else {
                IERC20(asset).safeTransfer(msg.sender, amount);
            }
            return amount;
        }

        uint256 remaining = amount - baseBal;
        // data is encoded as (address[] sellTokens, bytes[] calldatas)
        if (remaining > 0 && data.length > 0) {
            (address[] memory sellTokens, bytes[] memory calldatas) = abi.decode(data, (address[], bytes[]));
            require(sellTokens.length == calldatas.length, "BadData");
            for (uint256 i = 0; i < sellTokens.length && remaining > 0; i++) {
                address sellT = sellTokens[i];
                uint256 callValue = 0;
                if (sellT == address(0)) {
                    // selling ETH -> base (unlikely for withdraw-to-base when base is ETH); skip unless router encodes it
                    // Value must be included in calldata semantics; here we do not attach ETH automatically
                } else {
                    uint256 tBal = IERC20(sellT).balanceOf(address(this));
                    if (tBal == 0) { continue; }
                    IERC20(sellT).forceApprove(swapTarget, 0);
                    IERC20(sellT).forceApprove(swapTarget, tBal);
                }

                uint256 baseBefore = asset == address(0)
                    ? address(this).balance
                    : IERC20(asset).balanceOf(address(this));
                (bool success,) = swapTarget.call{value: callValue}(calldatas[i]);
                if (success) {
                    uint256 baseAfter = asset == address(0)
                        ? address(this).balance
                        : IERC20(asset).balanceOf(address(this));
                    uint256 baseOut = baseAfter - baseBefore;
                    if (baseOut >= remaining) {
                        remaining = 0;
                    } else {
                        remaining -= baseOut;
                    }
                    emit WithdrawSellExecuted(sellT, 0, baseOut);
                }
            }
        }

        // Auto-sell path (MVP): if no calldatas provided, attempt to sell index tokens to raise base via mock router API
        if (remaining > 0 && data.length == 0 && swapTarget != address(0)) {
            IMockSwapRouter router_ = IMockSwapRouter(swapTarget);

            uint256 n = indexTokens.length;
            for (uint256 i = 0; i < n && remaining > 0; i++) {
                address t = indexTokens[i];
                if (t == address(0) || t == asset) { continue; }
                uint256 bal = IERC20(t).balanceOf(address(this));
                if (bal == 0) { continue; }

                uint256 sellAmount = bal;
                if (priceOracle != address(0)) {
                    // aim to sell just enough to cover remaining
                    uint256 estBase = IPriceOracle(priceOracle).quote(t, asset, bal);
                    if (estBase > remaining && estBase > 0) {
                        // proportional sell: sellAmount ~= bal * remaining / estBase
                        sellAmount = (bal * remaining) / estBase;
                        if (sellAmount == 0) sellAmount = bal; // fallback
                    }
                }

                IERC20(t).forceApprove(swapTarget, 0);
                IERC20(t).forceApprove(swapTarget, sellAmount);

                uint256 baseBefore2 = IERC20(asset).balanceOf(address(this));
                try router_.swapFrom(t, asset, sellAmount, address(this), address(this)) returns (uint256 /*got*/) {
                    uint256 baseAfter2 = IERC20(asset).balanceOf(address(this));
                    uint256 gotBase = baseAfter2 - baseBefore2;
                    if (gotBase >= remaining) {
                        remaining = 0;
                    } else {
                        remaining -= gotBase;
                    }
                    emit WithdrawSellExecuted(t, sellAmount, gotBase);
                } catch {}
            }
        }

        uint256 sendAmount = amount - remaining;
        if (sendAmount > 0) {
            if (asset == address(0)) {
                (bool s2,) = payable(msg.sender).call{value: sendAmount}("");
                require(s2, "ETHSendFail");
            } else {
                IERC20(asset).safeTransfer(msg.sender, sendAmount);
            }
        }
        return sendAmount;
    }

    function harvest() external override onlyRouter returns (uint256, address[] memory, uint256[] memory) {
        // Auto-sell all non-base index tokens into base asset using swapTarget
        uint256 baseBefore = asset == address(0)
            ? address(this).balance
            : IERC20(asset).balanceOf(address(this));

        if (swapTarget != address(0)) {
            uint256 n = indexTokens.length;
            for (uint256 i = 0; i < n; i++) {
                address t = indexTokens[i];
                if (t == address(0) || t == asset) { continue; }
                uint256 bal = IERC20(t).balanceOf(address(this));
                if (bal == 0) { continue; }
                IERC20(t).forceApprove(swapTarget, 0);
                IERC20(t).forceApprove(swapTarget, bal);
                try IMockSwapRouter(swapTarget).swapFrom(t, asset, bal, address(this), address(this)) returns (uint256 /*got*/) {
                    // ignore
                } catch {
                    // ignore failures per token to continue others
                }
            }
        }

        uint256 baseAfter = asset == address(0)
            ? address(this).balance
            : IERC20(asset).balanceOf(address(this));
        uint256 delta = baseAfter - baseBefore;

        // Transfer realized base to router (msg.sender)
        if (delta > 0) {
            if (asset == address(0)) {
                (bool s,) = payable(msg.sender).call{value: delta}("");
                require(s, "ETHSendFail");
            } else {
                IERC20(asset).safeTransfer(msg.sender, delta);
            }
        }
        return (delta, new address[](0), new uint256[](0));
    }

   

  

    function approveTokenSpenderSimple(
        address token,
        address spender,
        uint256 amount
    ) external onlyProtocolOwner {
        require(token != address(0), "TokenZero");
        require(spender != address(0), "SpenderZero");
        IERC20(token).forceApprove(spender, 0);
        IERC20(token).forceApprove(spender, amount);
        emit ApprovalGranted(token, spender, amount, msg.sender);
    }

    function totalAssets() external view override returns (uint256) {
        uint256 total = asset == address(0)
            ? address(this).balance
            : IERC20(asset).balanceOf(address(this));
        for (uint256 i = 0; i < indexTokens.length; i++) {
            address t = indexTokens[i];
            // Skip counting the base asset token itself to avoid double-counting
            if (t == asset) { continue; }
            // Skip native pseudo-token; if you plan to hold native, handle via oracle separately
            if (t == address(0)) { continue; }

            uint256 bal = IERC20(t).balanceOf(address(this));
            if (bal == 0) continue;
            if (priceOracle != address(0)) {
                total += IPriceOracle(priceOracle).quote(t, asset, bal);
            } else {
                // Fallback: add raw balance (not value-adjusted)
                total += bal;
            }
        }
        return total;
    }

    // Views
    function getIndexTokens() external view returns (address[] memory) {
        return indexTokens;
    }

    function getTokenInfo(address token) external view returns (bool whitelisted, uint256 tokenBalance) {
        whitelisted = isWhitelisted[token];
        tokenBalance = token == address(0)
            ? address(this).balance
            : IERC20(token).balanceOf(address(this));
    }

    // Internal
    function _addTokens(address[] memory tokens_) internal {
        for (uint256 i = 0; i < tokens_.length; i++) {
            address t = tokens_[i];
            require(t != address(0), "Zero");
            require(!isWhitelisted[t], "Exists");
            if (whitelistRegistry != address(0)) {
                require(IWhitelistRegistryV3(whitelistRegistry).isTokenWhitelisted(t), "TokenNotWhitelisted");
            }
            isWhitelisted[t] = true;
            indexTokens.push(t);
        }
        emit TokensAdded(tokens_);
    }

    // Accept native ETH (e.g., from swaps)
    receive() external payable {}
}

