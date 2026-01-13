// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library BaseMainnet {
    // Uniswap V3 on Base
    address public constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address public constant QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address public constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    
    // Chainlink Price Feeds on Base Mainnet
    address public constant ETH_USD_FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address public constant WBTC_USD_FEED = 0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E;
    address public constant USDC_USD_FEED = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address public constant DAI_USD_FEED = 0x591e79239a7d679378eC8c847e5038150364C78F;
    address public constant CBETH_USD_FEED = 0xd7818272B9e248357d13057AAb0B417aF31E817d;
    
    // Common Tokens on Base Mainnet
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address public constant DAI = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address public constant CBETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;
    address public constant WBTC = 0x0555E30da8f98308EdB960aa94C0Db47230d2B9c;
    
    // Pool Fees (Uniswap V3)
    uint24 public constant FEE_LOWEST = 100;
    uint24 public constant FEE_LOW = 500;
    uint24 public constant FEE_MEDIUM = 3000;
    uint24 public constant FEE_HIGH = 10000;
}
