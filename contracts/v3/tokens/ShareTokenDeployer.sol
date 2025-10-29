// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../tokens/ShareTokenOFT.sol";

contract ShareTokenDeployer {
    function deployShareToken(string memory name_, string memory symbol_, address lzEndpoint_, address initialOwner_)
        external
        returns (address)
    {
        ShareTokenOFT token = new ShareTokenOFT(name_, symbol_, lzEndpoint_, initialOwner_);
        return address(token);
    }
}
