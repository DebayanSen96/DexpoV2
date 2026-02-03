// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title ETHStakingAdapter
 * @notice Adapter for accumulating ETH and staking via Ethereum Deposit Contract + SSV Network
 * @dev This adapter:
 *      1. Accumulates ETH deposits from the router (farm)
 *      2. Once 32 ETH threshold is reached, allows staking via Ethereum Deposit Contract
 *      3. Registers validator keyshares with SSV Network for distributed validation
 *      4. Withdrawal credentials point to this contract, so rewards accrue here
 */

interface IDepositContract {
    function deposit(
        bytes calldata pubkey,
        bytes calldata withdrawal_credentials,
        bytes calldata signature,
        bytes32 deposit_data_root
    ) external payable;
}

interface ISSVNetwork {
    struct Cluster {
        uint32 validatorCount;
        uint64 networkFeeIndex;
        uint64 index;
        bool active;
        uint256 balance;
    }

    function registerValidator(
        bytes calldata publicKey,
        uint64[] calldata operatorIds,
        bytes calldata shares,
        uint256 amount,
        Cluster calldata cluster
    ) external;

    function removeValidator(
        bytes calldata publicKey,
        uint64[] calldata operatorIds,
        Cluster calldata cluster
    ) external;

    function deposit(
        address owner,
        uint64[] calldata operatorIds,
        uint256 amount,
        Cluster calldata cluster
    ) external;

    function withdraw(
        uint64[] calldata operatorIds,
        uint256 amount,
        Cluster calldata cluster
    ) external;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ETHStakingAdapter is Ownable, ReentrancyGuard, EIP712 {
    
    uint256 public constant STAKING_THRESHOLD = 32 ether;
    uint256 public constant DEPOSIT_AMOUNT = 32 ether;
    
    address public immutable asset; // address(0) for native ETH
    address public protocolCore;
    address public router;
    bool public routerSet;
    
    IDepositContract public immutable depositContract;
    ISSVNetwork public immutable ssvNetwork;
    IERC20 public immutable ssvToken;
    
    uint256 public totalETHDeposited;
    uint256 public totalETHStaked;
    uint256 public activeValidators;
    
    struct ValidatorInfo {
        bytes pubkey;
        uint64[] operatorIds;
        bytes shares;
        bool isActive;
        uint256 stakedAmount;
        uint256 depositTimestamp;
    }
    
    mapping(bytes => ValidatorInfo) public validators;
    bytes[] public validatorPubkeys;
    
    bytes32 private constant STAKE_TYPEHASH = keccak256(
        "Stake(bytes pubkey,bytes withdrawalCredentials,bytes signature,bytes32 depositDataRoot,uint64[] operatorIds,bytes shares,uint256 ssvAmount,uint256 deadline,uint256 nonce)"
    );
    
    mapping(uint256 => bool) public usedNonces;
    uint256 public nonce;
    
    event ETHReceived(address indexed from, uint256 amount, uint256 totalBalance);
    event ValidatorStaked(bytes indexed pubkey, uint256 amount, uint64[] operatorIds);
    event ValidatorRegisteredSSV(bytes indexed pubkey, uint64[] operatorIds);
    event ValidatorRemoved(bytes indexed pubkey);
    event RewardsHarvested(uint256 amount);
    event RouterSet(address indexed router);
    event SSVTokensDeposited(uint256 amount);
    
    error NotRouter();
    error NotProtocolOwner();
    error InsufficientBalance();
    error InvalidSignature();
    error Expired();
    error ValidatorAlreadyExists();
    error ValidatorNotFound();
    error ThresholdNotReached();
    
    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }
    
    modifier onlyProtocolOwner() {
        if (msg.sender != Ownable(protocolCore).owner()) revert NotProtocolOwner();
        _;
    }
    
    constructor(
        address protocolCore_,
        address depositContract_,
        address ssvNetwork_,
        address ssvToken_
    ) Ownable(msg.sender) EIP712("ETHStakingAdapter", "1") {
        require(protocolCore_ != address(0), "Invalid protocol core");
        require(depositContract_ != address(0), "Invalid deposit contract");
        require(ssvNetwork_ != address(0), "Invalid SSV network");
        require(ssvToken_ != address(0), "Invalid SSV token");
        
        asset = address(0);
        protocolCore = protocolCore_;
        depositContract = IDepositContract(depositContract_);
        ssvNetwork = ISSVNetwork(ssvNetwork_);
        ssvToken = IERC20(ssvToken_);
    }
    
    function setRouterOnce(address r) external {
        require(!routerSet, "Router already set");
        require(r != address(0), "Zero address");
        address coreOwner = Ownable(protocolCore).owner();
        require(
            msg.sender == protocolCore ||
            msg.sender == coreOwner ||
            msg.sender == Ownable(r).owner(),
            "Unauthorized"
        );
        router = r;
        routerSet = true;
        emit RouterSet(r);
    }
    
    /**
     * @notice Deposit ETH from router into the adapter
     * @param amount Amount of ETH to deposit
     * @return Amount deposited
     */
    function deposit(uint256 amount, bytes calldata) external payable onlyRouter returns (uint256) {
        require(msg.value == amount, "ETH amount mismatch");
        totalETHDeposited += amount;
        emit ETHReceived(msg.sender, amount, address(this).balance);
        return amount;
    }
    
    /**
     * @notice Withdraw ETH back to router
     * @param amount Amount to withdraw
     * @return Amount withdrawn
     */
    function withdraw(uint256 amount, bytes calldata) external onlyRouter returns (uint256) {
        uint256 routerBalance = address(this).balance;
        if (routerBalance < amount) revert InsufficientBalance();
        
        totalETHDeposited -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "ETH transfer failed");
        
        return amount;
    }
    
    /**
     * @notice Stake 32 ETH to create a new validator
     * @dev Requires signature from protocol owner only
     * @param pubkey Validator public key (48 bytes)
     * @param withdrawalCredentials Withdrawal credentials (32 bytes, should be 0x01 + 11 zeros + this contract address)
     * @param signature Validator signature (96 bytes)
     * @param depositDataRoot Deposit data root (32 bytes)
     * @param operatorIds SSV operator IDs
     * @param shares Encrypted keyshares for SSV operators
     * @param ssvAmount Amount of SSV tokens to deposit for operational costs
     * @param cluster Current cluster snapshot
     * @param deadline Signature expiration timestamp
     * @param v Signature v component (protocol owner)
     * @param r Signature r component (protocol owner)
     * @param s Signature s component (protocol owner)
     */
    function stakeValidator(
        bytes calldata pubkey,
        bytes calldata withdrawalCredentials,
        bytes calldata signature,
        bytes32 depositDataRoot,
        uint64[] calldata operatorIds,
        bytes calldata shares,
        uint256 ssvAmount,
        ISSVNetwork.Cluster calldata cluster,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        if (address(this).balance < DEPOSIT_AMOUNT) revert ThresholdNotReached();
        if (validators[pubkey].isActive) revert ValidatorAlreadyExists();
        
        require(pubkey.length == 48, "Invalid pubkey length");
        require(withdrawalCredentials.length == 32, "Invalid withdrawal credentials length");
        require(signature.length == 96, "Invalid signature length");
        require(operatorIds.length >= 4 && operatorIds.length <= 13, "Invalid operator count");
        
        bytes32 structHash = keccak256(
            abi.encode(
                STAKE_TYPEHASH,
                keccak256(pubkey),
                keccak256(withdrawalCredentials),
                keccak256(signature),
                depositDataRoot,
                keccak256(abi.encodePacked(operatorIds)),
                keccak256(shares),
                ssvAmount,
                deadline,
                nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        
        address protocolOwner = Ownable(protocolCore).owner();
        address signer = ecrecover(digest, v, r, s);
        
        require(signer == protocolOwner, "Invalid protocol owner signature");
        require(!usedNonces[nonce], "Nonce already used");
        usedNonces[nonce] = true;
        nonce++;
        
        depositContract.deposit{value: DEPOSIT_AMOUNT}(
            pubkey,
            withdrawalCredentials,
            signature,
            depositDataRoot
        );
        
        totalETHStaked += DEPOSIT_AMOUNT;
        
        if (ssvAmount > 0) {
            require(
                ssvToken.transferFrom(msg.sender, address(this), ssvAmount),
                "SSV token transfer failed"
            );
            ssvToken.approve(address(ssvNetwork), ssvAmount);
            
            ssvNetwork.registerValidator(
                pubkey,
                operatorIds,
                shares,
                ssvAmount,
                cluster
            );
            
            emit SSVTokensDeposited(ssvAmount);
            emit ValidatorRegisteredSSV(pubkey, operatorIds);
        }
        
        validators[pubkey] = ValidatorInfo({
            pubkey: pubkey,
            operatorIds: operatorIds,
            shares: shares,
            isActive: true,
            stakedAmount: DEPOSIT_AMOUNT,
            depositTimestamp: block.timestamp
        });
        validatorPubkeys.push(pubkey);
        activeValidators++;
        
        emit ValidatorStaked(pubkey, DEPOSIT_AMOUNT, operatorIds);
    }
    
    /**
     * @notice Remove a validator from SSV network
     * @dev Can only be called by protocol owner
     */
    function removeValidator(
        bytes calldata pubkey,
        ISSVNetwork.Cluster calldata cluster
    ) external onlyProtocolOwner nonReentrant {
        ValidatorInfo storage validator = validators[pubkey];
        if (!validator.isActive) revert ValidatorNotFound();
        
        ssvNetwork.removeValidator(
            pubkey,
            validator.operatorIds,
            cluster
        );
        
        validator.isActive = false;
        activeValidators--;
        
        emit ValidatorRemoved(pubkey);
    }
    
    /**
     * @notice Deposit additional SSV tokens for operational costs
     */
    function depositSSVTokens(
        uint64[] calldata operatorIds,
        uint256 amount,
        ISSVNetwork.Cluster calldata cluster
    ) external onlyProtocolOwner {
        require(
            ssvToken.transferFrom(msg.sender, address(this), amount),
            "SSV token transfer failed"
        );
        ssvToken.approve(address(ssvNetwork), amount);
        
        ssvNetwork.deposit(address(this), operatorIds, amount, cluster);
        emit SSVTokensDeposited(amount);
    }
    
    /**
     * @notice Withdraw SSV tokens
     */
    function withdrawSSVTokens(
        uint64[] calldata operatorIds,
        uint256 amount,
        ISSVNetwork.Cluster calldata cluster
    ) external onlyProtocolOwner {
        ssvNetwork.withdraw(operatorIds, amount, cluster);
        
        uint256 balance = ssvToken.balanceOf(address(this));
        if (balance > 0) {
            ssvToken.transfer(msg.sender, balance);
        }
    }
    
    /**
     * @notice Harvest staking rewards (ETH that accumulates in contract from validator rewards)
     * @dev Called by router to collect rewards
     * @return baseDelta Amount of ETH rewards harvested
     * @return rewardTokens Empty array (no additional reward tokens)
     * @return rewardAmts Empty array
     */
    function harvest() external onlyRouter returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    ) {
        uint256 currentBalance = address(this).balance;
        uint256 expectedBalance = totalETHDeposited - totalETHStaked;
        
        if (currentBalance > expectedBalance) {
            baseDelta = currentBalance - expectedBalance;
            
            if (baseDelta > 0) {
                (bool success, ) = payable(msg.sender).call{value: baseDelta}("");
                require(success, "ETH transfer failed");
                emit RewardsHarvested(baseDelta);
            }
        }
        
        return (baseDelta, new address[](0), new uint256[](0));
    }
    
    /**
     * @notice Get total assets managed by adapter
     * @return Total ETH (deposited - staked + current balance for rewards)
     */
    function totalAssets() external view returns (uint256) {
        return address(this).balance + totalETHStaked;
    }
    
    /**
     * @notice Get available ETH balance (not yet staked)
     */
    function availableBalance() external view returns (uint256) {
        return address(this).balance;
    }
    
    /**
     * @notice Check if threshold is reached for staking
     */
    function canStake() external view returns (bool) {
        return address(this).balance >= STAKING_THRESHOLD;
    }
    
    /**
     * @notice Get validator information
     */
    function getValidator(bytes calldata pubkey) external view returns (ValidatorInfo memory) {
        return validators[pubkey];
    }
    
    /**
     * @notice Get all validator pubkeys
     */
    function getAllValidators() external view returns (bytes[] memory) {
        return validatorPubkeys;
    }
    
    /**
     * @notice Get active validator count
     */
    function getActiveValidatorCount() external view returns (uint256) {
        return activeValidators;
    }
    
    /**
     * @notice Generate withdrawal credentials for this contract
     * @dev Returns 0x01 prefix + 11 zero bytes + 20 bytes of contract address
     */
    function getWithdrawalCredentials() external view returns (bytes memory) {
        bytes memory creds = new bytes(32);
        creds[0] = 0x01; // ETH1 withdrawal prefix
        
        bytes20 addrBytes = bytes20(address(this));
        for (uint256 i = 0; i < 20; i++) {
            creds[i + 12] = addrBytes[i];
        }
        
        return creds;
    }
    
    /**
     * @notice EMERGENCY: Send all ETH directly to protocol owner
     * @dev Only callable by protocol owner, bypasses all checks
     */
    function emergencyWithdrawAll() external onlyProtocolOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        
        (bool success, ) = payable(msg.sender).call{value: balance}("");
        require(success, "ETH transfer failed");
        
        emit ETHReceived(msg.sender, 0, 0);
    }
    
    receive() external payable {
        emit ETHReceived(msg.sender, msg.value, address(this).balance);
    }
}
