// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../modules/LidoCSMAdapter.sol";

contract HoodiTestnetLidoCSMAdapter is LidoCSMAdapter {
    constructor(
        address csModule,
        address csAccounting,
        address permissionlessGate,
        address csejector,
        address oracle,
        address weth,
        address steth
    ) LidoCSMAdapter(csModule, csAccounting, permissionlessGate, csejector, oracle, weth, steth) {}
}
