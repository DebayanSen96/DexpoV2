// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVaultFactory {
    // Mirror config structs used by LockupPolicy and PayoutPolicy
    struct LockConfig {
        bool enabled;
        bool allowEarlyExit;
        uint16 earlyExitBps; // 0-10000
        uint256 lockupSeconds;
        uint8 postLockMode;
    }

    struct PayoutConfig {
        uint8 mode; // 0=Stream,1=Lockup
        uint16 streamBps; // 0-10000
        uint16 compoundBps; // 0-10000
        uint256 epoch;
        uint256 minHarvestInterval;
        bool compoundLpOnLock;
    }

    /// ShareToken configuration to be applied atomically during vault creation
    struct ShareTokenConfig {
        bool transferable;
        uint16 transferFeeBps; // 0-1500 typical cap
        address feeReceiver;
        address protocolFeeReceiver;
        uint16 protocolRakeBps; // 0-2000 typical cap
    }

    struct VaultAddresses {
        address baseVault;
        address router;
        address payoutPolicy;
        address lockupPolicy;
        address stakeholderRegistry;
    }

    /**
     * @notice Deploys a complete v3 vault stack and wires all modules.
     * @param asset           The base asset (ERC20) for the vault
     * @param vaultName       ShareToken name
     * @param vaultSymbol     ShareToken symbol
     * @param core            ProtocolCore address (for StakeholderRegistry)
     * @param farmId          Unique id assigned by ProtocolCore
     * @param owner           Farm owner who will receive ownership of all modules
     * @param ownerRecipient  Initial ownerRecipient for StakeholderRegistry
     * @param lpBps           LP split (basis points)
     * @param ownerBps        Owner split (basis points)
     * @param verifierBps     Verifier split (basis points)
     * @param lockCfg         Lockup policy config
     * @param payoutCfg       Payout policy config
     * @param adapterKeys     Strategy keys for router allocations
     * @param adapterAddrs    Adapter addresses aligned with keys
     * @param adapterBps      Allocation bps per adapter; must sum to 10000 or be empty
     */
    function createVaultStack(
        address asset,
        string calldata vaultName,
        string calldata vaultSymbol,
        address core,
        uint256 farmId,
        address owner,
        address ownerRecipient,
        uint16 lpBps,
        uint16 ownerBps,
        uint16 verifierBps,
        LockConfig calldata lockCfg,
        PayoutConfig calldata payoutCfg,
        ShareTokenConfig calldata stCfg,
        bytes32[] calldata adapterKeys,
        address[] calldata adapterAddrs,
        uint16[] calldata adapterBps
    ) external returns (VaultAddresses memory addrs);
}
