// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../mainnet/modules/borrow/BorrowHub.sol";

contract SepoliaTestnetBorrowHub is BorrowHub {
    constructor(address protocolCore, address oracle) BorrowHub(protocolCore, oracle) {}
}

