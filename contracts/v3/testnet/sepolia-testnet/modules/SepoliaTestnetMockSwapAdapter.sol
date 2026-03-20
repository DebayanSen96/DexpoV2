// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../test/MockSwapAdapter.sol";

contract SepoliaTestnetMockSwapAdapter is MockSwapAdapter {
    constructor(address router) MockSwapAdapter(router) {}
}
