// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../../ProtocolCore.sol";

contract SepoliaTestnetProtocolCore is ProtocolCore {
    constructor(address dxpToken, uint256 fallbackRatio, uint256 protocolFeeRate, uint256 reserveRatio)
        ProtocolCore(dxpToken, fallbackRatio, protocolFeeRate, reserveRatio)
    {}
}
