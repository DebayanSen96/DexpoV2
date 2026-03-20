// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../factories/IndexSwapFactory.sol";

contract SepoliaTestnetIndexSwapFactory is IndexSwapFactory {
    constructor(address protocolCore, address moduleRegistry, address indexSwapImplementation, address feeCollector)
        IndexSwapFactory(protocolCore, moduleRegistry, indexSwapImplementation, feeCollector)
    {}
}
