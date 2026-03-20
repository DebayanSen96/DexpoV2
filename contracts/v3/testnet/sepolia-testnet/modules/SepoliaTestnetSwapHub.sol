// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../mainnet/modules/swap/SwapHub.sol";

contract SepoliaTestnetSwapHub is SwapHub {
    constructor(address protocolCore, address oracle) SwapHub(protocolCore, oracle) {}
}
