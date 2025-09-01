// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWhitelistRegistryV3 {
    // Views
    function isTokenWhitelisted(address token) external view returns (bool);
    function isAdapterWhitelisted(address adapter) external view returns (bool);
    function isDexApproved(address swapRouter, address quoter) external view returns (bool);
    function isPoolAllowed(address base, address token, uint24 fee, address swapRouter) external view returns (bool);

    // Admin (suggested, but adapters/routers will not call these)
    function setTokenWhitelist(address token, bool allowed) external;
    function setAdapterWhitelist(address adapter, bool allowed) external;
    function setDexApproved(address swapRouter, address quoter, bool allowed) external;
    function setPoolAllowed(address base, address token, uint24 fee, address swapRouter, bool allowed) external;
}
