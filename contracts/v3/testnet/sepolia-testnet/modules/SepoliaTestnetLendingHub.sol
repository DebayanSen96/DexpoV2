// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../mainnet/modules/lending/LendingHub.sol";

contract SepoliaTestnetLendingHub is LendingHub {
    constructor(address protocolCore, address oracle) LendingHub(protocolCore, oracle) {}
}
