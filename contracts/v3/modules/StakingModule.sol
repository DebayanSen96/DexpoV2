// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IProtocolCore {
    function owner() external view returns (address);
}

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

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

contract StakingModule is Ownable, ReentrancyGuard, EIP712 {
    
    uint256 public constant STAKING_THRESHOLD = 32 ether;
    uint256 public constant DEPOSIT_AMOUNT = 32 ether;
    
    address public immutable protocolCore;
    IDepositContract public immutable depositContract;
    ISSVNetwork public immutable ssvNetwork;
    IERC20 public immutable ssvToken;
    
    struct ValidatorInfo {
        bytes pubkey;
        uint64[] operatorIds;
        bytes shares;
        bool isActive;
        uint256 stakedAmount;
        uint256 depositTimestamp;
    }
    
    struct VaultStakingState {
        uint256 totalDeposited;
        uint256 totalStaked;
        uint256 activeValidators;
    }
    
    mapping(address => VaultStakingState) public vaultStates;
    mapping(address => mapping(bytes => ValidatorInfo)) public vaultValidators;
    mapping(address => bytes[]) public vaultValidatorPubkeys;
    
    bytes32 private constant STAKE_TYPEHASH = keccak256(
        "Stake(address vault,bytes pubkey,bytes withdrawalCredentials,bytes signature,bytes32 depositDataRoot,uint64[] operatorIds,bytes shares,uint256 ssvAmount,uint256 deadline,uint256 nonce)"
    );
    
    mapping(address => uint256) public vaultNonces;
    
    event NativeDeposited(address indexed vault, uint256 amount, uint256 totalBalance);
    event NativeWithdrawn(address indexed vault, uint256 amount);
    event ValidatorStaked(address indexed vault, bytes indexed pubkey, uint256 amount, uint64[] operatorIds);
    event ValidatorRegisteredSSV(address indexed vault, bytes indexed pubkey, uint64[] operatorIds);
    event ValidatorRemoved(address indexed vault, bytes indexed pubkey);
    event RewardsHarvested(address indexed vault, uint256 amount);
    event SSVTokensDeposited(address indexed vault, uint256 amount);
    
    error NotAuthorized();
    error InsufficientBalance();
    error InvalidSignature();
    error Expired();
    error ValidatorAlreadyExists();
    error ValidatorNotFound();
    error ThresholdNotReached();
    error ZeroAmount();
    error TransferFailed();
    
    constructor(
        address _protocolCore,
        address _depositContract,
        address _ssvNetwork,
        address _ssvToken
    ) Ownable(msg.sender) EIP712("StakingModule", "1") {
        require(_protocolCore != address(0), "Invalid protocol core");
        require(_depositContract != address(0), "Invalid deposit contract");
        require(_ssvNetwork != address(0), "Invalid SSV network");
        require(_ssvToken != address(0), "Invalid SSV token");
        
        protocolCore = _protocolCore;
        depositContract = IDepositContract(_depositContract);
        ssvNetwork = ISSVNetwork(_ssvNetwork);
        ssvToken = IERC20(_ssvToken);
    }
    
    modifier onlyAuthorized(address vault) {
        bool isSafeOwner = false;
        bool isProtocolOwner = false;
        
        try IVaultSafe(vault).isOwner(msg.sender) returns (bool result) {
            isSafeOwner = result;
        } catch {}
        
        try IProtocolCore(protocolCore).owner() returns (address po) {
            isProtocolOwner = (msg.sender == po);
        } catch {}
        
        if (!isSafeOwner && !isProtocolOwner) revert NotAuthorized();
        _;
    }
    
    function depositNative(address vault) external payable onlyAuthorized(vault) nonReentrant returns (uint256) {
        if (msg.value == 0) revert ZeroAmount();
        
        vaultStates[vault].totalDeposited += msg.value;
        
        emit NativeDeposited(vault, msg.value, address(this).balance);
        return msg.value;
    }
    
    function withdrawNative(address vault, uint256 amount) external onlyAuthorized(vault) nonReentrant returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        
        VaultStakingState storage state = vaultStates[vault];
        uint256 availableBalance = state.totalDeposited - state.totalStaked;
        
        if (availableBalance < amount) revert InsufficientBalance();
        
        state.totalDeposited -= amount;
        
        (bool success, ) = payable(vault).call{value: amount}("");
        if (!success) revert TransferFailed();
        
        emit NativeWithdrawn(vault, amount);
        return amount;
    }
    
    function stakeValidator(
        address vault,
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
    ) external onlyAuthorized(vault) nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        
        VaultStakingState storage state = vaultStates[vault];
        uint256 availableBalance = state.totalDeposited - state.totalStaked;
        
        if (availableBalance < DEPOSIT_AMOUNT) revert ThresholdNotReached();
        if (vaultValidators[vault][pubkey].isActive) revert ValidatorAlreadyExists();
        
        require(pubkey.length == 48, "Invalid pubkey length");
        require(withdrawalCredentials.length == 32, "Invalid withdrawal credentials length");
        require(signature.length == 96, "Invalid signature length");
        require(operatorIds.length >= 4 && operatorIds.length <= 13, "Invalid operator count");
        
        uint256 currentNonce = vaultNonces[vault];
        bytes32 structHash = keccak256(
            abi.encode(
                STAKE_TYPEHASH,
                vault,
                keccak256(pubkey),
                keccak256(withdrawalCredentials),
                keccak256(signature),
                depositDataRoot,
                keccak256(abi.encodePacked(operatorIds)),
                keccak256(shares),
                ssvAmount,
                deadline,
                currentNonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        
        address protocolOwner = IProtocolCore(protocolCore).owner();
        address signer = ecrecover(digest, v, r, s);
        
        require(signer == protocolOwner, "Invalid protocol owner signature");
        vaultNonces[vault]++;
        
        depositContract.deposit{value: DEPOSIT_AMOUNT}(
            pubkey,
            withdrawalCredentials,
            signature,
            depositDataRoot
        );
        
        state.totalStaked += DEPOSIT_AMOUNT;
        
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
            
            emit SSVTokensDeposited(vault, ssvAmount);
            emit ValidatorRegisteredSSV(vault, pubkey, operatorIds);
        }
        
        vaultValidators[vault][pubkey] = ValidatorInfo({
            pubkey: pubkey,
            operatorIds: operatorIds,
            shares: shares,
            isActive: true,
            stakedAmount: DEPOSIT_AMOUNT,
            depositTimestamp: block.timestamp
        });
        vaultValidatorPubkeys[vault].push(pubkey);
        state.activeValidators++;
        
        emit ValidatorStaked(vault, pubkey, DEPOSIT_AMOUNT, operatorIds);
    }
    
    function removeValidator(
        address vault,
        bytes calldata pubkey,
        ISSVNetwork.Cluster calldata cluster
    ) external onlyAuthorized(vault) nonReentrant {
        ValidatorInfo storage validator = vaultValidators[vault][pubkey];
        if (!validator.isActive) revert ValidatorNotFound();
        
        ssvNetwork.removeValidator(
            pubkey,
            validator.operatorIds,
            cluster
        );
        
        validator.isActive = false;
        vaultStates[vault].activeValidators--;
        
        emit ValidatorRemoved(vault, pubkey);
    }
    
    function depositSSVTokens(
        address vault,
        uint64[] calldata operatorIds,
        uint256 amount,
        ISSVNetwork.Cluster calldata cluster
    ) external onlyAuthorized(vault) {
        require(
            ssvToken.transferFrom(msg.sender, address(this), amount),
            "SSV token transfer failed"
        );
        ssvToken.approve(address(ssvNetwork), amount);
        
        ssvNetwork.deposit(address(this), operatorIds, amount, cluster);
        emit SSVTokensDeposited(vault, amount);
    }
    
    function withdrawSSVTokens(
        address vault,
        uint64[] calldata operatorIds,
        uint256 amount,
        ISSVNetwork.Cluster calldata cluster
    ) external onlyAuthorized(vault) {
        ssvNetwork.withdraw(operatorIds, amount, cluster);
        
        uint256 balance = ssvToken.balanceOf(address(this));
        if (balance > 0) {
            ssvToken.transfer(vault, balance);
        }
    }
    
    function harvest(address vault) external onlyAuthorized(vault) nonReentrant returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    ) {
        VaultStakingState storage state = vaultStates[vault];
        uint256 expectedBalance = state.totalDeposited - state.totalStaked;
        uint256 currentBalance = address(this).balance;
        
        if (currentBalance > expectedBalance) {
            baseDelta = currentBalance - expectedBalance;
            
            if (baseDelta > 0) {
                state.totalDeposited += baseDelta;
                
                (bool success, ) = payable(vault).call{value: baseDelta}("");
                if (!success) revert TransferFailed();
                
                state.totalDeposited -= baseDelta;
                
                emit RewardsHarvested(vault, baseDelta);
            }
        }
        
        return (baseDelta, new address[](0), new uint256[](0));
    }
    
    function getPositionValue(address vault, address) external view returns (uint256) {
        VaultStakingState storage state = vaultStates[vault];
        return state.totalDeposited;
    }
    
    function getVaultState(address vault) external view returns (
        uint256 totalDeposited,
        uint256 totalStaked,
        uint256 activeValidators,
        uint256 availableBalance
    ) {
        VaultStakingState storage state = vaultStates[vault];
        totalDeposited = state.totalDeposited;
        totalStaked = state.totalStaked;
        activeValidators = state.activeValidators;
        availableBalance = totalDeposited - totalStaked;
    }
    
    function canStake(address vault) external view returns (bool) {
        VaultStakingState storage state = vaultStates[vault];
        uint256 availableBalance = state.totalDeposited - state.totalStaked;
        return availableBalance >= STAKING_THRESHOLD;
    }
    
    function getValidator(address vault, bytes calldata pubkey) external view returns (ValidatorInfo memory) {
        return vaultValidators[vault][pubkey];
    }
    
    function getAllValidators(address vault) external view returns (bytes[] memory) {
        return vaultValidatorPubkeys[vault];
    }
    
    function getActiveValidatorCount(address vault) external view returns (uint256) {
        return vaultStates[vault].activeValidators;
    }
    
    function getWithdrawalCredentials(address vault) external pure returns (bytes memory) {
        bytes memory creds = new bytes(32);
        creds[0] = 0x01;
        
        bytes20 addrBytes = bytes20(vault);
        for (uint256 i = 0; i < 20; i++) {
            creds[i + 12] = addrBytes[i];
        }
        
        return creds;
    }
    
    function emergencyWithdrawAll(address vault) external nonReentrant {
        address protocolOwner = IProtocolCore(protocolCore).owner();
        require(msg.sender == protocolOwner, "Only protocol owner");
        
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        
        (bool success, ) = payable(vault).call{value: balance}("");
        if (!success) revert TransferFailed();
        
        vaultStates[vault].totalDeposited = 0;
    }
    
    receive() external payable {
        emit NativeDeposited(address(0), msg.value, address(this).balance);
    }
}
