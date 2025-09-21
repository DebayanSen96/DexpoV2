// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../v3/interfaces/IFarmFactory.sol";

/**
 * @title FarmCreationModule
 * @notice Thin external module that wraps farm factory creation to keep ProtocolCore bytecode small
 *         and avoid stack-too-deep at non-viaIR compilation targets.
 */
contract FarmCreationModule {
    function createFarmWithMin(
        IFarmFactory factory,
        address asset,
        string calldata farmName,
        string calldata farmSymbol,
        address core,
        uint256 farmId,
        address owner,
        address ownerRecipient,
        uint16 lpBps,
        uint16 ownerBps,
        uint16 verifierBps,
        IFarmFactory.LockConfig calldata lockCfg,
        IFarmFactory.PayoutConfig calldata payoutCfg,
        IFarmFactory.ShareTokenConfig calldata stCfg,
        bytes32[] calldata adapterKeys,
        address[] calldata adapterAddrs,
        uint16[] calldata adapterBps,
        uint256 minSubscriptionBaseUnits
    ) external returns (IFarmFactory.FarmAddresses memory addrs) {
        addrs = factory.createFarmStackWithMin(
            asset,
            farmName,
            farmSymbol,
            core,
            farmId,
            owner,
            ownerRecipient,
            lpBps,
            ownerBps,
            verifierBps,
            lockCfg,
            payoutCfg,
            stCfg,
            adapterKeys,
            adapterAddrs,
            adapterBps,
            minSubscriptionBaseUnits
        );
    }
}
