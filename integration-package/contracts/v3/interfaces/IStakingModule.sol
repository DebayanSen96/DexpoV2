// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStakingModule {
    function depositBond(address vault, uint256 amount, bytes calldata validatorData) external;
    function claimRewards(address vault) external returns (uint256);
    function getPositionValue(address vault, address token) external view returns (uint256);
    function getNodeOperatorId(address vault) external view returns (uint256);
    function getBondedEth(address vault) external view returns (uint256);
}
