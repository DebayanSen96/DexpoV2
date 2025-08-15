// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IStakeholderRegistry.sol";
import "../interfaces/IProtocolCore.sol";

contract StakeholderRegistry is IStakeholderRegistry, Ownable {
    Splits private _splits; // lp, owner, verifier
    address private _ownerRecipient;

    IProtocolCore public protocolCore;
    uint256 public immutable farmId;

    event SplitsSet(uint16 lpBps, uint16 ownerBps, uint16 verifierBps);
    event OwnerRecipientSet(address recipient);

    constructor(address core, uint256 farmId_) {
        require(core != address(0), "CoreZero");
        protocolCore = IProtocolCore(core);
        farmId = farmId_;
    }

    function setSplits(uint16 lpBps, uint16 ownerBps, uint16 verifierBps) external override onlyOwner {
        require(uint256(lpBps) + ownerBps + verifierBps == 10_000, "SumBps");
        _splits = Splits({ lpBps: lpBps, ownerBps: ownerBps, verifierBps: verifierBps });
        emit SplitsSet(lpBps, ownerBps, verifierBps);
    }

    function getSplits() external view override returns (Splits memory) {
        return _splits;
    }

    function setOwnerRecipient(address recipient) external override onlyOwner {
        _ownerRecipient = recipient;
        emit OwnerRecipientSet(recipient);
    }

    function ownerRecipient() external view override returns (address) {
        return _ownerRecipient;
    }

    function activeVerifiers() external view override returns (address[] memory) {
        return protocolCore.getApprovedVerifiers(farmId);
    }
}
