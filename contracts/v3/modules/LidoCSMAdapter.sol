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
    address public oracle;
    address public weth;

    address private constant ETH_SENTINEL = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    mapping(address => uint256) public vaultNodeOperatorId;
    mapping(address => uint256) public vaultBondedEth;
    mapping(address => bool) public vaultRegistered;

    event VaultRegistered(address indexed vault, uint256 noId);
    event BondDeposited(address indexed vault, uint256 amount, uint256 noId);
    event RewardsClaimed(address indexed vault, uint256 amount);

    constructor(
        address _csModule,
        address _csAccounting,
        address _permissionlessGate,
        address _oracle,
        address _weth
    ) Ownable(msg.sender) {
        csModule = _csModule;
        csAccounting = _csAccounting;
        permissionlessGate = _permissionlessGate;
        oracle = _oracle;
        weth = _weth;
    }

    function depositBond(address vault, uint256 amount, bytes calldata validatorData) external override {
        require(amount > 0, "Zero amount");

        (bytes memory pubkey, bytes memory signature) = abi.decode(validatorData, (bytes, bytes));
        require(pubkey.length == 48, "Invalid pubkey length");
        require(signature.length == 96, "Invalid signature length");

        IERC20(weth).safeTransferFrom(vault, address(this), amount);
        IWETH(weth).withdraw(amount);

        tuple_ManagementProperties memory mgmt = tuple_ManagementProperties({
            managerAddress: vault,
            rewardAddress: vault,
            extendedManagerPermissions: true
        });

        if (!vaultRegistered[vault]) {
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
            vaultBondedEth[vault] = amount;
            emit VaultRegistered(vault, noId);
        } else {
            uint256 noId = vaultNodeOperatorId[vault];
            (uint256 current, uint256 required) = ICSAccounting(csAccounting).getBondSummary(noId);
            if (current >= required) return;

            uint256 needed = required - current;
            if (amount > needed) amount = needed;

            (bool ok, ) = csAccounting.call{value: amount}(
                abi.encodeWithSignature("depositETH(address,uint256)", vault, noId)
            );
            require(ok, "depositETH failed");
            vaultBondedEth[vault] += amount;
        }

        emit BondDeposited(vault, amount, vaultNodeOperatorId[vault]);
    }

    function claimRewards(address vault) external override returns (uint256) {
        return 0;
    }

    function getPositionValue(address vault, address) external view override returns (uint256) {
        if (!vaultRegistered[vault]) return 0;
        uint256 noId = vaultNodeOperatorId[vault];
        try ICSAccounting(csAccounting).getBondSummary(noId) returns (uint256 current, uint256) {
            uint256 ethPrice = IOracle(oracle).priceUsdE18(ETH_SENTINEL);
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

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
    }

    receive() external payable {}
}
