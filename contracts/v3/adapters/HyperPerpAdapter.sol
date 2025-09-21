// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategyAdapter.sol";
import "../interfaces/IOwnable.sol";

interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}

/**
 * @title HyperPerpAdapter (Hyperliquid HyperEVM)
 * @notice Minimal v3 adapter that allocates USDC to HyperCore perp margin and allows manager to place/cancel orders.
 *         USDC-only. On deposit, USDC is bridged EVM->Core and moved to perp. On withdraw, moved back Core->EVM.
 */
contract HyperPerpAdapter is IStrategyAdapter, Ownable {
    using SafeERC20 for IERC20;

    // --- Immutable config ---
    address public immutable override asset;              // EVM ERC20 (USDC)
    address public immutable protocolCore;                // v3 ProtocolCore (for governance checks if needed)
    address public immutable coreWriter;                  // 0x3333..33

    // HyperCore token metadata for USDC
    uint64  public immutable usdcTokenId;                 // Core token id (uint64)
    address public immutable usdcSystemAddress;           // Core system address for USDC (0x20..index)

    // Cached decimals for conversions
    uint8 private immutable _assetDecimals;               // ERC20 decimals (USDC: 6)
    uint8 private constant CORE_DECIMALS = 8;             // Core "size" decimals used in action payloads

    // --- Wiring ---
    address public router;                                // StrategyRouter; set once by factory during farm creation
    bool public routerSet;

    // --- Events ---
    event RouterSet(address indexed router);
    event TradeAction(uint24 indexed actionId, bytes data);

    // --- Errors ---
    error NotRouter();

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    constructor(
        address _asset,
        address _protocolCore,
        uint64 _usdcTokenId,
        address _usdcSystemAddress,
        address _initialOwner
    ) Ownable(_initialOwner) {
        require(_asset != address(0) && _protocolCore != address(0) && _usdcSystemAddress != address(0) && _initialOwner != address(0), "Zero");
        asset = _asset;
        protocolCore = _protocolCore;
        usdcTokenId = _usdcTokenId;
        usdcSystemAddress = _usdcSystemAddress;
        coreWriter = 0x3333333333333333333333333333333333333333;
        _assetDecimals = IERC20Metadata(_asset).decimals();
    }

    // One-time router set by factory (acts while it temporarily owns router)
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

    // --- IStrategyAdapter ---

    function deposit(uint256 amount, bytes calldata) external payable override onlyRouter returns (uint256) {
        require(amount > 0, "Amt");
        // Pull USDC from router to adapter
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        // EVM -> Core: transfer ERC20 to the token's Core system address (credits Core spot)
        IERC20(asset).safeTransfer(usdcSystemAddress, amount);
        // Core: Spot -> Perp margin (action 7)
        _sendUsdClassTransfer(_toCoreUnits(amount), true);
        return amount;
    }

    function withdraw(uint256 amount, bytes calldata) external override onlyRouter returns (uint256 received) {
        require(amount > 0, "Amt");
        // Perp -> Spot (action 7)
        _sendUsdClassTransfer(_toCoreUnits(amount), false);
        // Core -> EVM credit (action 6 spot send); destination must be the token's system address
        _sendSpotSend(usdcSystemAddress, usdcTokenId, _toCoreUnits(amount));
        // After CoreWriter pipeline, USDC ERC20 is credited to this adapter. Send out what we currently have up to amount.
        uint256 bal = IERC20(asset).balanceOf(address(this));
        uint256 toSend = bal >= amount ? amount : bal;
        if (toSend > 0) {
            IERC20(asset).safeTransfer(msg.sender, toSend);
        }
        return toSend;
    }

    function harvest() external override onlyRouter returns (uint256, address[] memory, uint256[] memory) {
        // No separate rewards; funding PnL realized on position close. Return 0.
        address[] memory rTok = new address[](0);
        uint256[] memory rAmt = new uint256[](0);
        return (0, rTok, rAmt);
    }

    function totalAssets() external view override returns (uint256) {
        // MVP: return adapter's current EVM USDC balance.
        // Extend later using L1Read precompiles for vault equity.
        return IERC20(asset).balanceOf(address(this));
    }

    // --- Manager trading (perp only) ---
    function placeLimitOrder(
        uint32 assetId,
        bool isBuy,
        uint64 limitPx1e8,
        uint64 sz1e8,
        bool reduceOnly,
        uint8 tif,
        uint128 cloid
    ) external onlyOwner {
        bytes memory enc = abi.encode(assetId, isBuy, limitPx1e8, sz1e8, reduceOnly, tif, cloid);
        _sendAction(1, enc);
    }

    function cancelOrderByOid(uint32 assetId, uint64 oid) external onlyOwner {
        _sendAction(10, abi.encode(assetId, oid));
    }

    function cancelOrderByCloid(uint32 assetId, uint128 cloid) external onlyOwner {
        _sendAction(11, abi.encode(assetId, cloid));
    }

    // --- Internals ---
    function _toCoreUnits(uint256 amountErc20) internal view returns (uint64) {
        // Convert ERC20 decimals to CORE_DECIMALS with rounding down, clamp to uint64
        if (_assetDecimals == CORE_DECIMALS) {
            return uint64(amountErc20);
        } else if (_assetDecimals < CORE_DECIMALS) {
            uint256 scaled = amountErc20 * (10 ** (CORE_DECIMALS - _assetDecimals));
            return uint64(scaled);
        } else {
            uint256 scaled = amountErc20 / (10 ** (_assetDecimals - CORE_DECIMALS));
            return uint64(scaled);
        }
    }

    function _sendUsdClassTransfer(uint64 ntl, bool toPerp) internal {
        _sendAction(7, abi.encode(ntl, toPerp));
    }

    function _sendSpotSend(address destinationSystemAddr, uint64 tokenId, uint64 weiAmount) internal {
        bytes memory payload = abi.encode(destinationSystemAddr, tokenId, weiAmount);
        _sendAction(6, payload);
    }

    function _sendAction(uint24 actionId, bytes memory encodedFields) internal {
        // Build [1 byte version][3 bytes actionId BE][payload]
        bytes memory data = new bytes(4 + encodedFields.length);
        data[0] = 0x01; // version 1
        data[1] = bytes1(uint8(actionId >> 16));
        data[2] = bytes1(uint8(actionId >> 8));
        data[3] = bytes1(uint8(actionId));
        for (uint256 i = 0; i < encodedFields.length; i++) {
            data[4 + i] = encodedFields[i];
        }
        ICoreWriter(coreWriter).sendRawAction(data);
        emit TradeAction(actionId, data);
    }
}
