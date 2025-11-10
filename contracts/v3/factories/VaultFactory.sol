// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IProtocolCore.sol";
import "../vault/BaseVault.sol";

contract VaultFactory is Ownable {
    address public immutable protocolCore;

    event VaultCreated(address indexed vault, address indexed asset, uint256 indexed farmId);

    // Lightweight registry for discovery
    mapping(address => address[]) public vaultsByOwner; // owner(EOA) => list of vaults
    mapping(address => address) public ownerByVault;    // vault => owner(EOA)

    error NotCore();
    address public coreModule; // optional module allowed to act as core

    // Default USD pricer used if per-vault override is zero
    address public defaultUsdPricer;

    modifier onlyCoreOrModule() {
        if (msg.sender != protocolCore && msg.sender != coreModule) revert NotCore();
        _;
    }

    constructor(address core) Ownable(msg.sender) {
        require(core != address(0), "CoreZero");
        protocolCore = core;
    }

    function setCoreModule(address module) external onlyOwner { coreModule = module; }
    function setDefaultUsdPricer(address pricer) external onlyOwner { defaultUsdPricer = pricer; }

    function createVault(
        address asset,
        string calldata name,
        string calldata symbol,
        address core,
        address ownerEoa,
        uint256 farmId,
        address usdPricer,
        address assetsValuer,
        uint8 shareDecimals,
        bool shareTransferable,
        uint16 transferFeeBps
    ) external onlyCoreOrModule returns (address vault) {
        require(asset != address(0) && core != address(0) && ownerEoa != address(0), "Zero");
        address pricer = usdPricer == address(0) ? defaultUsdPricer : usdPricer;
        Vault4626 v = new Vault4626(
            asset,
            core,
            ownerEoa,
            name,
            symbol,
            pricer,
            assetsValuer,
            shareDecimals,
            0,
            0,
            shareTransferable,
            transferFeeBps
        );
        vault = address(v);
        IProtocolCoreV3(core).registerFarm(ownerEoa, vault, farmId);
        vaultsByOwner[ownerEoa].push(vault);
        ownerByVault[vault] = ownerEoa;
        emit VaultCreated(vault, asset, farmId);
    }
}
