// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../interfaces/IProtocolCoreOwnable.sol";

contract VaultSafe is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- State Variables ---
    address public immutable protocolCore;
    address[] public owners;
    uint256 public immutable threshold;
    
    mapping(address => bool) public isOwner;
    mapping(bytes32 => Transaction) public transactions;
    mapping(bytes32 => mapping(address => bool)) public confirmations;
    
    // We store IDs to allow enumeration/history fetching
    bytes32[] public transactionIds; 
    
    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmationCount;
        uint256 timestamp;
        bool exists; 
    }
    
    // --- Events ---
    event TransactionSubmitted(bytes32 indexed txHash, address indexed submitter, address to, uint256 value, bytes data);
    event TransactionConfirmed(bytes32 indexed txHash, address indexed owner);
    event TransactionExecuted(bytes32 indexed txHash, address indexed executor);
    event TransactionRevoked(bytes32 indexed txHash, address indexed owner);
    
    // --- Modifiers ---
    modifier onlyOwner() {
        require(isOwner[msg.sender], "Not owner");
        _;
    }
    
    modifier onlyOwnerOrProtocolOwner() {
        bool isVaultOwner = isOwner[msg.sender];
        bool isProtocolOwner = false;
        
        if (protocolCore != address(0)) {
            try IProtocolCoreOwnable(protocolCore).owner() returns (address po) {
                isProtocolOwner = (msg.sender == po);
            } catch {}
        }
        
        require(isVaultOwner || isProtocolOwner, "Not authorized");
        _;
    }
    
    modifier txExists(bytes32 txHash) {
        require(transactions[txHash].exists, "Tx does not exist");
        _;
    }
    
    modifier notExecuted(bytes32 txHash) {
        require(!transactions[txHash].executed, "Tx already executed");
        _;
    }
    
    modifier notConfirmed(bytes32 txHash) {
        require(!confirmations[txHash][msg.sender], "Tx already confirmed");
        _;
    }
    
    // --- Constructor ---
    constructor(
        address _protocolCore,
        address[] memory _owners,
        uint256 _threshold
    ) {
        require(_owners.length > 0, "Owners required");
        require(_threshold > 0 && _threshold <= _owners.length, "Invalid threshold");
        
        for (uint256 i = 0; i < _owners.length; i++) {
            address owner = _owners[i];
            require(owner != address(0), "Invalid owner");
            require(!isOwner[owner], "Duplicate owner");
            
            isOwner[owner] = true;
            owners.push(owner);
        }
        
        threshold = _threshold;
        protocolCore = _protocolCore;
    }
    
    // --- Core Logic ---

    function submitTransaction(
        address to,
        uint256 value,
        bytes calldata data
    ) external onlyOwnerOrProtocolOwner nonReentrant returns (bytes32 txHash) {
        uint256 txIndex = transactionIds.length;
        
        // SECURITY FIX 1: Use abi.encode (not packed) to prevent collision on dynamic types
        // SECURITY FIX 2: Include ChainID to prevent replay attacks on forks
        txHash = keccak256(abi.encode(txIndex, to, value, data, block.timestamp, block.chainid));
        
        // SECURITY FIX 3: Explicit collision guard
        require(!transactions[txHash].exists, "Tx collision detected");
        
        transactionIds.push(txHash);

        Transaction storage txn = transactions[txHash];
        txn.to = to;
        txn.value = value;
        txn.data = data;
        txn.executed = false;
        txn.confirmationCount = 0;
        txn.timestamp = block.timestamp;
        txn.exists = true;
        
        emit TransactionSubmitted(txHash, msg.sender, to, value, data);
        
        // If threshold is 1, execute immediately
        if (threshold == 1) {
            require(isOwner[msg.sender], "Owner confirmation required");
            _executeTransaction(txHash);
        } else {
            // Auto-confirm only for listed safe owners.
            if (isOwner[msg.sender]) {
                _confirmTransaction(txHash, msg.sender);
            }
        }
    }
    
    function confirmTransaction(bytes32 txHash)
        external
        onlyOwner
        txExists(txHash)
        notExecuted(txHash)
        notConfirmed(txHash)
        nonReentrant
    {
        _confirmTransaction(txHash, msg.sender);
    }

    // LOGIC FIX: Added explicit execute function for retries/relayers
    function executeTransaction(bytes32 txHash) 
        external 
        onlyOwnerOrProtocolOwner
        txExists(txHash)
        notExecuted(txHash)
        nonReentrant 
    {
        require(transactions[txHash].confirmationCount >= threshold, "Not enough confirmations");
        _executeTransaction(txHash);
    }

    function _confirmTransaction(bytes32 txHash, address confirmer) internal {
        confirmations[txHash][confirmer] = true;
        transactions[txHash].confirmationCount++;
        
        emit TransactionConfirmed(txHash, confirmer);
        
        if (transactions[txHash].confirmationCount >= threshold) {
            _executeTransaction(txHash);
        }
    }
    
    function _executeTransaction(bytes32 txHash) internal {
        Transaction storage txn = transactions[txHash];
        
        // Check-Effects-Interactions Pattern
        txn.executed = true;
        
        (bool success, ) = txn.to.call{value: txn.value}(txn.data);
        require(success, "Tx execution failed");
        
        emit TransactionExecuted(txHash, msg.sender);
    }
    
    function revokeConfirmation(bytes32 txHash)
        external
        onlyOwner
        txExists(txHash)
        notExecuted(txHash)
    {
        require(confirmations[txHash][msg.sender], "Tx not confirmed");
        
        confirmations[txHash][msg.sender] = false;
        transactions[txHash].confirmationCount--;
        
        emit TransactionRevoked(txHash, msg.sender);
    }
    
    // --- View Functions ---

    function getOwners() external view returns (address[] memory) {
        return owners;
    }
    
    function getTransactionCount() external view returns (uint256) {
        return transactionIds.length;
    }

    // LOGIC FIX: Bounds checking for pagination
    function getTransactionIds(uint256 from, uint256 to) external view returns (bytes32[] memory _transactionIds) {
        require(from < to, "Invalid range");
        require(to <= transactionIds.length, "Out of bounds");
        
        uint256 len = to - from;
        _transactionIds = new bytes32[](len);
        for(uint256 i=0; i < len; i++) {
            _transactionIds[i] = transactionIds[from + i];
        }
    }

    // UX FIX: Helper to get full struct details easily
    function getTransaction(bytes32 txHash) external view returns (
        address to,
        uint256 value,
        bytes memory data,
        bool executed,
        uint256 confirmationCount,
        uint256 timestamp
    ) {
        Transaction storage txn = transactions[txHash];
        return (
            txn.to,
            txn.value,
            txn.data,
            txn.executed,
            txn.confirmationCount,
            txn.timestamp
        );
    }
    
    receive() external payable {}
}
