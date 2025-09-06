// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategyAdapter.sol";
import "../interfaces/IOwnable.sol";
import "../interfaces/IWhitelistRegistry.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title BluechipIndexAdapter (Simplified)
 * @notice Router-controlled adapter that simply holds multiple assets.
 *         Swaps require dual signatures: farm owner + protocol owner (EIP-712).
 *         Withdrawals sell to base via whitelisted 0x target.
 */
contract BluechipIndexAdapter is IStrategyAdapter, Ownable, EIP712 {
    using SafeERC20 for IERC20;

    address public immutable override asset;
    address public protocolCore;
    address public router;
    bool public routerSet;

    address public whitelistRegistry;
    address public swapTarget; // 0x Exchange Proxy or other whitelisted target

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
    mapping(uint256 => bool) public usedNonces;
    uint256 public nonce;

    // Events
    event RouterSet(address indexed router);
    event WhitelistRegistrySet(address indexed registry);
    event SwapTargetSet(address indexed swapTarget);
    event TokensAdded(address[] tokens);
    event TokenRemoved(address indexed token);
    event SwapExecuted(address indexed sellToken, uint256 sellAmount, address indexed buyToken, uint256 buyAmount);
    event WithdrawSellExecuted(address indexed token, uint256 tokenIn, uint256 baseOut);
    event ApprovalGranted(address indexed token, address indexed spender, uint256 amount, address indexed caller);

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
        emit SwapTargetSet(swapTarget_);
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

    function setSwapTarget(address t) external onlyOwner {
        require(t != address(0), "Zero");
        swapTarget = t;
        emit SwapTargetSet(t);
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
        uint8 v1, bytes32 r1, bytes32 s1,
        uint8 v2, bytes32 r2, bytes32 s2
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

        address signer1 = ecrecover(digest, v1, r1, s1);
        address signer2 = ecrecover(digest, v2, r2, s2);

        require((signer1 == farmOwner && signer2 == protocolOwner) || (signer1 == protocolOwner && signer2 == farmOwner), "InvalidSignature");
        require(!usedNonces[nonce], "NonceUsed");
        usedNonces[nonce] = true;
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
        return (0, new address[](0), new uint256[](0));
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
            if (t == address(0)) {
                total += address(this).balance;
            } else {
                total += IERC20(t).balanceOf(address(this));
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

