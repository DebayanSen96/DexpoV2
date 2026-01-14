// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract FeeCollector is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public protocolCore;
    address public feeRecipient;
    
    uint16 public protocolCutBps = 1000;
    uint16 public constant MAX_PROTOCOL_CUT_BPS = 5000;
    uint16 public constant BPS_DIVISOR = 10000;
    
    mapping(address => bool) public authorizedVaults;
    mapping(address => uint256) public totalProtocolFees;
    mapping(address => mapping(address => uint256)) public vaultProtocolFees;
    
    event PerformanceFeeDistributed(
        address indexed vault,
        address indexed token,
        uint256 totalProfit,
        uint256 vaultOwnerFee,
        uint256 protocolFee,
        address vaultOwner,
        address protocolRecipient
    );
    event VaultAuthorized(address indexed vault, bool authorized);
    event ProtocolCutBpsUpdated(uint16 oldBps, uint16 newBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    
    error NotAuthorized();
    error FeeTooHigh();
    error ZeroAddress();
    
    constructor(address _protocolCore, address _feeRecipient) Ownable(msg.sender) {
        if (_protocolCore == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        protocolCore = _protocolCore;
        feeRecipient = _feeRecipient;
    }
    
    modifier onlyAuthorizedVault() {
        if (!authorizedVaults[msg.sender]) revert NotAuthorized();
        _;
    }
    
    function distributePerformanceFee(
        address token,
        uint256 totalProfit,
        uint16 vaultPerformanceFeeBps,
        address vaultOwner
    ) external onlyAuthorizedVault nonReentrant returns (uint256 vaultOwnerNet, uint256 protocolFee) {
        if (totalProfit == 0 || vaultPerformanceFeeBps == 0) return (0, 0);
        
        uint256 totalVaultOwnerFee = (totalProfit * vaultPerformanceFeeBps) / BPS_DIVISOR;
        if (totalVaultOwnerFee == 0) return (0, 0);
        
        protocolFee = (totalVaultOwnerFee * protocolCutBps) / BPS_DIVISOR;
        vaultOwnerNet = totalVaultOwnerFee - protocolFee;
        
        IERC20(token).safeTransferFrom(msg.sender, vaultOwner, vaultOwnerNet);
        
        if (protocolFee > 0) {
            IERC20(token).safeTransferFrom(msg.sender, feeRecipient, protocolFee);
            totalProtocolFees[token] += protocolFee;
            vaultProtocolFees[msg.sender][token] += protocolFee;
        }
        
        emit PerformanceFeeDistributed(
            msg.sender,
            token,
            totalProfit,
            vaultOwnerNet,
            protocolFee,
            vaultOwner,
            feeRecipient
        );
        
        return (vaultOwnerNet, protocolFee);
    }
    
    function setAuthorizedVault(address vault, bool authorized) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        authorizedVaults[vault] = authorized;
        emit VaultAuthorized(vault, authorized);
    }
    
    function setProtocolCutBps(uint16 newCutBps) external onlyOwner {
        if (newCutBps > MAX_PROTOCOL_CUT_BPS) revert FeeTooHigh();
        uint16 oldBps = protocolCutBps;
        protocolCutBps = newCutBps;
        emit ProtocolCutBpsUpdated(oldBps, newCutBps);
    }
    
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }
    
    function getTotalProtocolFees(address token) external view returns (uint256) {
        return totalProtocolFees[token];
    }
    
    function getVaultProtocolFees(address vault, address token) external view returns (uint256) {
        return vaultProtocolFees[vault][token];
    }
    
    function calculateFeeDistribution(
        uint256 totalProfit,
        uint16 vaultPerformanceFeeBps
    ) external view returns (uint256 lpProfit, uint256 vaultOwnerNet, uint256 protocolFee) {
        uint256 totalVaultOwnerFee = (totalProfit * vaultPerformanceFeeBps) / BPS_DIVISOR;
        protocolFee = (totalVaultOwnerFee * protocolCutBps) / BPS_DIVISOR;
        vaultOwnerNet = totalVaultOwnerFee - protocolFee;
        lpProfit = totalProfit - totalVaultOwnerFee;
        return (lpProfit, vaultOwnerNet, protocolFee);
    }
}
