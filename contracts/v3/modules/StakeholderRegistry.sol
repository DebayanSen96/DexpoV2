// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IStakeholderRegistry.sol";
import "../interfaces/IProtocolCore.sol";

/**
 * @title StakeholderRegistry (v3)
 * @notice Stores LP/Owner/Verifier splits and owner fee recipient per farm.
 */
contract StakeholderRegistry is IStakeholderRegistry, Ownable {
    Splits private _splits; // lp, owner, verifier
    address private _ownerRecipient;

    IProtocolCoreV3 public protocolCore;
    uint256 public farmId;

    event SplitsSet(uint16 lpBps, uint16 ownerBps, uint16 verifierBps);
    event OwnerRecipientSet(address recipient);

    /// @notice Parameterless constructor to satisfy Ownable base. Not used by clones.
    constructor() Ownable(msg.sender) {}

    bool private _initialized;

    /// @notice Initialize registry bound to a ProtocolCore and farm id, and set owner.
    /// @param core ProtocolCore address to query approved verifiers.
    /// @param farmId_ Farm id this registry belongs to.
    /// @param initialOwner Owner to assign for admin functions.
    function initialize(address core, uint256 farmId_, address initialOwner) external {
        require(!_initialized, "Init");
        require(core != address(0) && initialOwner != address(0), "Zero");
        protocolCore = IProtocolCoreV3(core);
        farmId = farmId_;
        _transferOwnership(initialOwner);
        _initialized = true;
    }

    /// @notice Set LP/Owner/Verifier splits. Must sum to 10_000 bps.
    function setSplits(uint16 lpBps, uint16 ownerBps, uint16 verifierBps) external override onlyOwner {
        require(uint256(lpBps) + ownerBps + verifierBps == 10_000, "SumBps");
        _splits = Splits({ lpBps: lpBps, ownerBps: ownerBps, verifierBps: verifierBps });
        emit SplitsSet(lpBps, ownerBps, verifierBps);
    }

    /// @notice Get current splits.
    function getSplits() external view override returns (Splits memory) {
        return _splits;
    }

    /// @notice Set the address receiving owner's fee share (optional).
    /// @param recipient Address to receive owner fees.
    function setOwnerRecipient(address recipient) external override onlyOwner {
        _ownerRecipient = recipient;
        emit OwnerRecipientSet(recipient);
    }

    /// @notice Return the current owner recipient.
    function ownerRecipient() external view override returns (address) {
        return _ownerRecipient;
    }

    /// @notice Return current approved verifiers from ProtocolCore for this farm.
    function activeVerifiers() external view override returns (address[] memory) {
        return protocolCore.getApprovedVerifiers(farmId);
    }
}
