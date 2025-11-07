// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IProtocolCore.sol";
import "../vault/BaseVault.sol";

contract VaultFactory is Ownable {
    address public immutable protocolCore;

    event VaultCreated(address indexed vault, address indexed asset, uint256 indexed farmId);

    // Lightweight registry for discovery
    mapping(address => address[]) public vaultsByOwner; // owner(core) => list of vaults
    mapping(address => address) public ownerByVault;    // vault => owner(core)

    error NotCore();
    address public coreModule; // optional module allowed to act as core

    modifier onlyCoreOrModule() {
        if (msg.sender != protocolCore && msg.sender != coreModule) revert NotCore();
        _;
    }

    constructor(address core) Ownable(msg.sender) {
        require(core != address(0), "CoreZero");
        protocolCore = core;
    }

    function setCoreModule(address module) external onlyOwner { coreModule = module; }

    function createVault(
        address asset,
        string calldata name,
        string calldata symbol,
        address core,
        uint256 farmId
    ) external onlyCoreOrModule returns (address vault) {
        require(asset != address(0) && core != address(0), "Zero");
        Vault4626 v = new Vault4626(asset, core, name, symbol);
        vault = address(v);
        IProtocolCoreV3(core).registerFarm(core, vault, farmId);
        vaultsByOwner[core].push(vault);
        ownerByVault[vault] = core;
        emit VaultCreated(vault, asset, farmId);
    }
}
