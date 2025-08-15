// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProtocolCore {
    function getApprovedVerifiers(uint256 farmId) external view returns (address[] memory);
    function isApprovedVerifier(uint256 farmId, address who) external view returns (bool);
}
