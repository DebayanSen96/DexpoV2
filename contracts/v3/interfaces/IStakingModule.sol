// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStakingModule {
    function depositBond(address vault, uint256 amount, bytes calldata validatorData) external;
    function claimRewards(address vault) external returns (uint256);
    function claimRewards(address vault, uint256 cumulativeFeeShares, bytes32[] calldata rewardsProof) external returns (uint256);
    function requestValidatorExit(address vault, uint256 startFrom, uint256 keysCount, address refundRecipient) external payable;
    function requestValidatorExitByKeyIndices(address vault, uint256[] calldata keyIndices, address refundRecipient) external payable;
    function getPositionValue(address vault, address token) external view returns (uint256);
    function getNodeOperatorId(address vault) external view returns (uint256);
    function getBondedEth(address vault) external view returns (uint256);
}
