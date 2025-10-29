// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/access/Ownable.sol";
import "@layerzerolabs/oft-evm/contracts/OFT.sol";
import "../interfaces/IShareToken.sol";

contract ShareTokenOFT is OFT, IShareToken {
    error TransfersDisabled();
    error InvalidMinter();
    error FeeTooHigh();

    uint16 public constant MAX_TRANSFER_FEE_BPS = 1500; // 15%
    uint16 public constant MAX_PROTOCOL_RAKE_BPS = 2000; // 20%

    address public minter;

    bool public transferable = true;
    uint16 public transferFeeBps;

    address public feeReceiver;
    address public protocolFeeReceiver;
    uint16 public protocolRakeBps = 500; // 5%

    event MinterUpdated(address indexed minter);
    event TransferabilitySet(bool enabled);
    event TransferFeeSet(uint16 feeBps);
    event FeeReceiverSet(address indexed receiver);
    event ProtocolFeeSet(address indexed receiver, uint16 rakeBps);

    constructor(string memory name_, string memory symbol_, address lzEndpoint_, address initialOwner_)
        OFT(name_, symbol_, lzEndpoint_, initialOwner_)
        Ownable(initialOwner_)
    {}

    modifier onlyMinter() {
        if (msg.sender != minter) revert InvalidMinter();
        _;
    }

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
        require(receiver != address(0), "ZeroReceiver");
        feeReceiver = receiver;
        emit FeeReceiverSet(receiver);
    }

    function setProtocolFee(address receiver, uint16 rakeBps) external onlyOwner {
        if (rakeBps > MAX_PROTOCOL_RAKE_BPS) revert FeeTooHigh();
        protocolFeeReceiver = receiver;
        protocolRakeBps = rakeBps;
        emit ProtocolFeeSet(receiver, rakeBps);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMinter {
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20) {
        if (!transferable && from != address(0) && to != address(0)) {
            revert TransfersDisabled();
        }

        if (
            transferFeeBps > 0 &&
            from != address(0) &&
            to != address(0) &&
            feeReceiver != address(0)
        ) {
            uint256 fee = (value * transferFeeBps) / 10_000;
            if (fee > 0) {
                uint256 protocolCut = protocolFeeReceiver == address(0) ? 0 : (fee * protocolRakeBps) / 10_000;
                uint256 ownerCut = fee - protocolCut;

                uint256 sendAmt = value - fee;
                super._update(from, to, sendAmt);
                if (ownerCut > 0) {
                    super._update(from, feeReceiver, ownerCut);
                }
                if (protocolCut > 0) {
                    super._update(from, protocolFeeReceiver, protocolCut);
                }
                return;
            }
        }

        super._update(from, to, value);
    }
}
