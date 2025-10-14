// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract USDXSender is Ownable {
    IERC20 public token;

    event TokenUpdated(address indexed token);
    event Sent(address indexed to, uint256 amount);

    constructor(address _token) Ownable(msg.sender) {
        _setToken(_token);
    }

    function setToken(address _token) external onlyOwner {
        _setToken(_token);
    }

    function _setToken(address _token) internal {
        require(_token != address(0), "token=0");
        token = IERC20(_token);
        emit TokenUpdated(_token);
    }

    function send(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        require(token.transfer(to, amount), "transfer failed");
        emit Sent(to, amount);
    }

    function recoverToken(address erc20, uint256 amount) external onlyOwner {
        IERC20(erc20).transfer(owner(), amount);
    }
}
