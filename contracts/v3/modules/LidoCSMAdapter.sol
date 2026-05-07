// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStakingModule.sol";
import "../interfaces/IOracle.sol";

interface IWETH {
    function withdraw(uint256 amount) external;
}

interface ICSModule {
    function getNodeOperatorsCount() external view returns (uint256);
    function getNodeOperator(uint256 noId) external view returns (
        uint32 totalAddedKeys, uint32 totalExitedKeys, uint32 totalDepositedKeys,
        uint32 totalVettedKeys, uint32 stuckValidatorsCount, uint32 depositableValidatorsCount,
        uint32 targetValidatorsCount, uint8 status, uint32 enqueuedCount,
        uint32 totalWithdrawnKeys, address managerAddress, address rewardAddress,
        address proposedManagerAddress, address proposedRewardAddress,
        bool extendedManagerPermissions, bool isActive
    );
}

interface ICSAccounting {
    function getBondSummary(uint256 noId) external view returns (uint256 current, uint256 required);
    function pullFeeRewards(uint256 nodeOperatorId, uint256 cumulativeFeeShares, bytes32[] calldata rewardsProof) external;
    function getClaimableRewardsAndBondShares(
        uint256 nodeOperatorId,
        uint256 cumulativeFeeShares,
        bytes32[] calldata rewardsProof
    ) external view returns (uint256);
    function claimRewardsStETH(
        uint256 nodeOperatorId,
        uint256 stETHAmount,
        uint256 cumulativeFeeShares,
        bytes32[] calldata rewardsProof
    ) external returns (uint256);
}

interface ICSEjector {
    function voluntaryEject(
        uint256 nodeOperatorId,
        uint256 startFrom,
        uint256 keysCount,
        address refundRecipient
    ) external payable;

    function voluntaryEjectByArray(
        uint256 nodeOperatorId,
        uint256[] calldata keyIndices,
        address refundRecipient
    ) external payable;
}

interface ILidoStETH {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPermissionlessGate {
    function addNodeOperatorETH(
        uint256 keysCount,
        bytes calldata publicKeys,
        bytes calldata signatures,
        tuple_ManagementProperties calldata managementProperties,
        address referrer
    ) external payable returns (uint256);
}

struct tuple_ManagementProperties {
    address managerAddress;
    address rewardAddress;
    bool extendedManagerPermissions;
}

contract LidoCSMAdapter is IStakingModule, Ownable {
    using SafeERC20 for IERC20;

    address public immutable csModule;
    address public immutable csAccounting;
    address public immutable permissionlessGate;
    address public immutable csejector;
    address public oracle;
    address public weth;
    address public steth;

    address private constant ETH_SENTINEL = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE; // kept for interface compat

    mapping(address => uint256) public vaultNodeOperatorId;
    mapping(address => uint256) public vaultBondedEth;
    mapping(address => uint256) public vaultAccruedRewardsEth;
    mapping(address => bool) public vaultRegistered;

    event VaultRegistered(address indexed vault, uint256 noId);
    event BondDeposited(address indexed vault, uint256 amount, uint256 noId);
    event RewardsClaimed(address indexed vault, uint256 amount);
    event ValidatorExitRequested(address indexed vault, uint256 indexed noId, uint256 startFrom, uint256 keysCount, address refundRecipient);
    event ValidatorExitRequestedByKeyIndices(address indexed vault, uint256 indexed noId, uint256[] keyIndices, address refundRecipient);
    event EmergencyETHRescued(address indexed to, uint256 amount);
    event EmergencyTokenRescued(address indexed token, address indexed to, uint256 amount);

    constructor(
        address _csModule,
        address _csAccounting,
        address _permissionlessGate,
        address _csejector,
        address _oracle,
        address _weth,
        address _steth
    ) Ownable(msg.sender) {
        csModule = _csModule;
        csAccounting = _csAccounting;
        permissionlessGate = _permissionlessGate;
        csejector = _csejector;
        oracle = _oracle;
        weth = _weth;
        steth = _steth;
    }

    modifier onlyVaultCaller(address vault) {
        require(msg.sender == vault, "Not vault caller");
        _;
    }

    function _pullAndUnwrap(address vault, uint256 amount) internal {
        require(amount > 0, "Zero amount");
        IERC20(weth).safeTransferFrom(vault, address(this), amount);
        IWETH(weth).withdraw(amount);
    }

    function depositBond(address vault, uint256 amount, bytes calldata validatorData) external override onlyVaultCaller(vault) {
        require(amount > 0, "Zero amount");

        (bytes memory pubkey, bytes memory signature) = abi.decode(validatorData, (bytes, bytes));
        require(pubkey.length == 48, "Invalid pubkey length");
        require(signature.length == 96, "Invalid signature length");

        tuple_ManagementProperties memory mgmt = tuple_ManagementProperties({
            managerAddress: address(this),
            rewardAddress: address(this),
            extendedManagerPermissions: true
        });

        if (!vaultRegistered[vault]) {
            _pullAndUnwrap(vault, amount);
            (bool ok, bytes memory ret) = permissionlessGate.call{value: amount}(
                abi.encodeWithSignature(
                    "addNodeOperatorETH(uint256,bytes,bytes,(address,address,bool),address)",
                    1, pubkey, signature, mgmt, address(0)
                )
            );
            require(ok, "addNodeOperatorETH failed");
            uint256 noId = abi.decode(ret, (uint256));
            vaultNodeOperatorId[vault] = noId;
            vaultRegistered[vault] = true;
            vaultBondedEth[vault] += amount;
            emit VaultRegistered(vault, noId);
        } else {
            uint256 noId = vaultNodeOperatorId[vault];
            (uint256 current, uint256 required) = ICSAccounting(csAccounting).getBondSummary(noId);
            if (current >= required) return;

            uint256 depositAmount = amount;
            uint256 needed = required - current;
            if (depositAmount > needed) depositAmount = needed;

            _pullAndUnwrap(vault, depositAmount);

            (bool ok, ) = csAccounting.call{value: depositAmount}(
                abi.encodeWithSignature("depositETH(address,uint256)", vault, noId)
            );
            require(ok, "depositETH failed");
            vaultBondedEth[vault] += depositAmount;
            amount = depositAmount;
        }

        emit BondDeposited(vault, amount, vaultNodeOperatorId[vault]);
    }

    function claimRewards(address vault) external override onlyVaultCaller(vault) returns (uint256) {
        if (!vaultRegistered[vault]) return 0;

        uint256 noId = vaultNodeOperatorId[vault];
        (uint256 current, uint256 required) = ICSAccounting(csAccounting).getBondSummary(noId);
        if (current <= required) return 0;

        uint256 excess = current - required;
        vaultAccruedRewardsEth[vault] += excess;
        emit RewardsClaimed(vault, excess);
        return excess;
    }

    function claimRewards(
        address vault,
        uint256 cumulativeFeeShares,
        bytes32[] calldata rewardsProof
    ) external override onlyVaultCaller(vault) returns (uint256 claimed) {
        claimed = _claimRewardsWithProof(vault, cumulativeFeeShares, rewardsProof);
    }

    function pullFeeRewardsAndClaim(
        address vault,
        uint256 cumulativeFeeShares,
        bytes32[] calldata rewardsProof
    ) external onlyVaultCaller(vault) returns (uint256 claimed) {
        claimed = _claimRewardsWithProof(vault, cumulativeFeeShares, rewardsProof);
    }

    function requestValidatorExit(
        address vault,
        uint256 startFrom,
        uint256 keysCount,
        address refundRecipient
    ) external payable override onlyOwner {
        require(vaultRegistered[vault], "Not registered");
        require(keysCount > 0, "No keys");
        uint256 noId = vaultNodeOperatorId[vault];
        ICSEjector(csejector).voluntaryEject{value: msg.value}(
            noId,
            startFrom,
            keysCount,
            refundRecipient
        );
        emit ValidatorExitRequested(vault, noId, startFrom, keysCount, refundRecipient);
    }

    function requestValidatorExitByKeyIndices(
        address vault,
        uint256[] calldata keyIndices,
        address refundRecipient
    ) external payable override onlyOwner {
        require(vaultRegistered[vault], "Not registered");
        require(keyIndices.length > 0, "No keys");
        uint256 noId = vaultNodeOperatorId[vault];
        ICSEjector(csejector).voluntaryEjectByArray{value: msg.value}(
            noId,
            keyIndices,
            refundRecipient
        );
        emit ValidatorExitRequestedByKeyIndices(vault, noId, keyIndices, refundRecipient);
    }

    function _claimRewardsWithProof(
        address vault,
        uint256 cumulativeFeeShares,
        bytes32[] calldata rewardsProof
    ) internal returns (uint256 claimed) {
        require(vaultRegistered[vault], "Not registered");
        uint256 noId = vaultNodeOperatorId[vault];

        uint256 claimableShares = ICSAccounting(csAccounting).getClaimableRewardsAndBondShares(
            noId,
            cumulativeFeeShares,
            rewardsProof
        );

        if (claimableShares == 0) return 0;

        uint256 stethBefore = ILidoStETH(steth).balanceOf(address(this));
        ICSAccounting(csAccounting).claimRewardsStETH(noId, claimableShares, cumulativeFeeShares, rewardsProof);
        uint256 stethAfter = ILidoStETH(steth).balanceOf(address(this));

        claimed = stethAfter - stethBefore;
        if (claimed == 0) return 0;

        vaultAccruedRewardsEth[vault] += claimed;
        require(ILidoStETH(steth).transfer(vault, claimed), "stETH transfer failed");
        emit RewardsClaimed(vault, claimed);
    }

    function getPositionValue(address vault, address) external view override returns (uint256) {
        if (!vaultRegistered[vault]) return 0;
        uint256 noId = vaultNodeOperatorId[vault];
        try ICSAccounting(csAccounting).getBondSummary(noId) returns (uint256 current, uint256) {
            uint256 ethPrice = IOracle(oracle).priceUsdE18(weth);
            return (current * ethPrice) / 1e18;
        } catch {
            return 0;
        }
    }

    function getNodeOperatorId(address vault) external view override returns (uint256) {
        return vaultNodeOperatorId[vault];
    }

    function getBondedEth(address vault) external view override returns (uint256) {
        return vaultBondedEth[vault];
    }

    function getAccruedRewardsEth(address vault) external view returns (uint256) {
        if (!vaultRegistered[vault]) return 0;
        uint256 noId = vaultNodeOperatorId[vault];
        (uint256 current, ) = ICSAccounting(csAccounting).getBondSummary(noId);
        uint256 principal = vaultBondedEth[vault];
        if (current <= principal) return 0;
        return current - principal;
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
    }

    function emergencyWithdrawETH(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        uint256 available = address(this).balance;
        uint256 withdrawAmount = amount == 0 ? available : amount;
        require(withdrawAmount <= available, "Insufficient ETH");

        (bool ok, ) = to.call{value: withdrawAmount}("");
        require(ok, "ETH transfer failed");
        emit EmergencyETHRescued(to, withdrawAmount);
    }

    function emergencyRescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(to != address(0), "Invalid recipient");
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 rescueAmount = amount == 0 ? balance : amount;
        require(rescueAmount <= balance, "Insufficient balance");
        IERC20(token).safeTransfer(to, rescueAmount);
        emit EmergencyTokenRescued(token, to, rescueAmount);
    }

    receive() external payable {}
}
