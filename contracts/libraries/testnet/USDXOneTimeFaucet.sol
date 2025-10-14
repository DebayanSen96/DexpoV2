// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract USDXOneTimeFaucet is Ownable {
    IERC20 public token;
    uint256 public claimAmount;

    mapping(address => bool) public hasClaimed;

    event TokensClaimed(address indexed claimer, uint256 amount);

    constructor(address _token, uint256 _claimAmount) Ownable(msg.sender) {
        require(_token != address(0), "token=0");
        token = IERC20(_token);
        claimAmount = _claimAmount;
    }

    function claim() external {
        require(!hasClaimed[msg.sender], "claimed");
        hasClaimed[msg.sender] = true;
        require(token.transfer(msg.sender, claimAmount), "xfer fail");
        emit TokensClaimed(msg.sender, claimAmount);
    }

    function updateClaimAmount(uint256 _claimAmount) external onlyOwner {
        claimAmount = _claimAmount;
    }

    function recoverTokens(address tokenAddress, uint256 amount) external onlyOwner {
        IERC20(tokenAddress).transfer(owner(), amount);
    }
}
