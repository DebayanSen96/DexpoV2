// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../../interfaces/IOracle.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}

contract ChainlinkOracle is IOracle, Ownable {
    
    mapping(address => address) public priceFeeds;
    mapping(address => uint256) public stalePriceThreshold;
    
    uint256 public defaultStaleThreshold = 1 hours;
    
    event PriceFeedSet(address indexed token, address indexed feed);
    event StaleThresholdSet(address indexed token, uint256 threshold);
    event DefaultStaleThresholdSet(uint256 threshold);
    
    error StalePrice(address token, uint256 updatedAt);
    error NegativePrice(address token);
    error NoPriceFeed(address token);
    
    constructor() Ownable(msg.sender) {}
    
    function setPriceFeed(address token, address feed) external onlyOwner {
        require(feed != address(0), "Invalid feed");
        priceFeeds[token] = feed;
        emit PriceFeedSet(token, feed);
    }
    
    function setPriceFeeds(address[] calldata tokens, address[] calldata feeds) external onlyOwner {
        require(tokens.length == feeds.length, "Length mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            require(feeds[i] != address(0), "Invalid feed");
            priceFeeds[tokens[i]] = feeds[i];
            emit PriceFeedSet(tokens[i], feeds[i]);
        }
    }
    
    function setStaleThreshold(address token, uint256 threshold) external onlyOwner {
        stalePriceThreshold[token] = threshold;
        emit StaleThresholdSet(token, threshold);
    }
    
    function setDefaultStaleThreshold(uint256 threshold) external onlyOwner {
        defaultStaleThreshold = threshold;
        emit DefaultStaleThresholdSet(threshold);
    }
    
    function priceUsdE18(address token) external view override returns (uint256) {
        (uint256 price, uint8 decimals) = getPrice(token);
        if (decimals == 18) return price;
        if (decimals < 18) {
            return price * (10 ** (18 - decimals));
        } else {
            return price / (10 ** (decimals - 18));
        }
    }
    
    function getPrice(address token) public view override returns (uint256 price, uint8 decimals) {
        address feed = priceFeeds[token];
        if (feed == address(0)) revert NoPriceFeed(token);
        
        AggregatorV3Interface priceFeed = AggregatorV3Interface(feed);
        
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = priceFeed.latestRoundData();
        
        if (answer <= 0) revert NegativePrice(token);
        require(updatedAt != 0, "Invalid round");
        require(answeredInRound >= roundId, "Stale round");
        
        uint256 threshold = stalePriceThreshold[token];
        if (threshold == 0) threshold = defaultStaleThreshold;
        
        if (block.timestamp - updatedAt > threshold) {
            revert StalePrice(token, updatedAt);
        }
        
        price = uint256(answer);
        decimals = priceFeed.decimals();
    }
    
    function hasPriceFeed(address token) external view returns (bool) {
        return priceFeeds[token] != address(0);
    }
}
