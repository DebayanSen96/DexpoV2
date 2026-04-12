// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockProtocolCoreOwner {
    address public owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function setOwner(address _owner) external {
        owner = _owner;
    }
}

