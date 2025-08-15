// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStakeholderRegistry {
    struct Splits { uint16 lpBps; uint16 ownerBps; uint16 verifierBps; }

    function setSplits(uint16 lpBps, uint16 ownerBps, uint16 verifierBps) external;
    function getSplits() external view returns (Splits memory);

    function setOwnerRecipient(address recipient) external;
    function ownerRecipient() external view returns (address);

    function activeVerifiers() external view returns (address[] memory);
}
