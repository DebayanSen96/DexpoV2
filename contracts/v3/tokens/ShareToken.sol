// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ShareToken (v3)
 * @notice ERC20 share token for Dexponent v3 vaults. Supports:
 *         - Transferability toggle
 *         - Transfer fee (<= 15%) split between farm owner and protocol rake
 *         - Mint/Burn restricted to the configured vault (minter)
 */
contract ShareToken is ERC20, Ownable {
    error TransfersDisabled();
    error InvalidMinter();
    error FeeTooHigh();

    uint16 public constant MAX_TRANSFER_FEE_BPS = 1500; // 15%
    uint16 public constant MAX_PROTOCOL_RAKE_BPS = 2000; // 20% cap on rake from the transfer fee portion

    // Vault allowed to mint/burn
    address public minter;

    // Transfer controls
    bool public transferable = true;
    uint16 public transferFeeBps; // 0..1500

    // Fee recipients
    address public feeReceiver;          // farm owner recipient
    address public protocolFeeReceiver;  // protocol recipient
    uint16 public protocolRakeBps = 500; // 5% by default

    event MinterUpdated(address indexed minter);
    event TransferabilitySet(bool enabled);
    event TransferFeeSet(uint16 feeBps);
    event FeeReceiverSet(address indexed receiver);
    event ProtocolFeeSet(address indexed receiver, uint16 rakeBps);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    // --- Admin ---

    function setMinter(address minter_) external onlyOwner {
        if (minter_ == address(0)) revert InvalidMinter();
        minter = minter_;
        emit MinterUpdated(minter_);
    }

    function setTransferable(bool enabled) external onlyOwner {
        transferable = enabled;
        emit TransferabilitySet(enabled);
    }

    function setTransferFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_TRANSFER_FEE_BPS) revert FeeTooHigh();
        transferFeeBps = bps;
        emit TransferFeeSet(bps);
    }

    function setFeeReceiver(address receiver) external onlyOwner {
        feeReceiver = receiver;
        emit FeeReceiverSet(receiver);
    }

    function setProtocolFee(address receiver, uint16 rakeBps) external onlyOwner {
        if (rakeBps > MAX_PROTOCOL_RAKE_BPS) revert FeeTooHigh();
        protocolFeeReceiver = receiver;
        protocolRakeBps = rakeBps;
        emit ProtocolFeeSet(receiver, rakeBps);
    }

    // --- Mint/Burn ---

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "NotMinter");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == minter, "NotMinter");
        _burn(from, amount);
    }

    // --- Transfers with optional fee ---

    function _transfer(address from, address to, uint256 amount) internal override {
        if (!transferable && from != address(0) && to != address(0)) {
            revert TransfersDisabled();
        }

        uint256 fee = 0;
        if (
            transferFeeBps > 0 &&
            from != address(0) &&
            to != address(0) &&
            feeReceiver != address(0)
        ) {
            fee = (amount * transferFeeBps) / 10_000;
            if (fee > 0) {
                uint256 protocolCut = protocolFeeReceiver == address(0) ? 0 : (fee * protocolRakeBps) / 10_000;
                uint256 ownerCut = fee - protocolCut;

                // send net amount to recipient
                uint256 sendAmt = amount - fee;
                super._transfer(from, to, sendAmt);

                // route fee splits
                if (ownerCut > 0) {
                    super._transfer(from, feeReceiver, ownerCut);
                }
                if (protocolCut > 0) {
                    super._transfer(from, protocolFeeReceiver, protocolCut);
                }
                return;
            }
        }

        super._transfer(from, to, amount);
    }
}
