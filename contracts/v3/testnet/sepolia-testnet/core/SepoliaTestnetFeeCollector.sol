// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../mainnet/core/FeeCollector.sol";

contract SepoliaTestnetFeeCollector is FeeCollector {
    constructor(address protocolCore, address feeRecipient) FeeCollector(protocolCore, feeRecipient) {}
}
