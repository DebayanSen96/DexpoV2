// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IGuard {
    function check(address to, uint256 value, bytes calldata data) external view;
    function checkAfter(address to, uint256 value, bytes calldata data, bytes calldata result) external view;
}

contract UserVault is ReentrancyGuard, EIP712 {
    // EIP-1271 magic value
    bytes4 internal constant EIP1271_MAGICVALUE = 0x1626ba7e;

    struct Action {
        address to;
        uint256 value;
        bytes data;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 private constant ACTION_TYPEHASH = keccak256(
        "Action(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline)"
    );

    // Batch support (compact arrays hashed under EIP-712)
    bytes32 private constant BATCH_TYPEHASH = keccak256(
        "Batch(bytes32 toHash,bytes32 valueHash,bytes32 dataHash,uint256 nonce,uint256 deadline)"
    );

    mapping(address => bool) public isOwner;
    address[] public owners;
    uint8 public threshold;
    uint256 public nonce;

    uint256 private constant MAX_BATCH = 100;

    event Executed(address indexed to, uint256 value, bytes data, bytes result);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event OwnerSwapped(address indexed oldOwner, address indexed newOwner);
    event ThresholdChanged(uint8 threshold);
    event GuardSet(address indexed guard);
    event BatchExecuted(uint256 count);

    error InvalidOwners();
    error InvalidThreshold();
    error NotOwner();
    error DeadlineExpired();
    error NonceInvalid();
    error InsufficientSignatures();
    error DuplicateOrInvalidSigner();
    error CallFailed();
    error SelfCallNotAllowed();
    error InvalidSelector();
    error InvalidBatchLength();
    error InvalidGuard();
    // module-related errors removed

    modifier onlySelfOrSingleOwner() {
        if (msg.sender == address(this)) {
            _;
            return;
        }
        if (!isOwner[msg.sender] || threshold != 1) revert NotOwner();
        _;
    }

    constructor(
        address[] memory _owners,
        uint8 _threshold,
        bytes32[] memory /*initialModules*/,
        address[][] memory /*initialModuleTargets*/
    ) EIP712("UserVault", "1") {
        if (_owners.length == 0 || _owners.length > 5) revert InvalidOwners();
        if (_threshold == 0 || _threshold > _owners.length) revert InvalidThreshold();
        for (uint256 i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            if (o == address(0) || isOwner[o]) revert InvalidOwners();
            isOwner[o] = true;
        }
        owners = _owners;
        threshold = _threshold;
        nonce = 0;
    }

    function ownersLength() external view returns (uint256) { return owners.length; }

    address public guard;

    function setGuard(address g) external onlySelfOrSingleOwner {
        if (g != address(0)) {
            if (g.code.length == 0) revert InvalidGuard();
        }
        guard = g;
        emit GuardSet(g);
    }

    // Emergency path to remove a stuck or malicious guard. Does not invoke guard hooks.
    function emergencyRemoveGuard() external onlySelfOrSingleOwner {
        guard = address(0);
        emit GuardSet(address(0));
    }

    // module functions removed

    function directExecute(address to, uint256 value, bytes calldata data)
        external
        payable
        nonReentrant
        onlySelfOrSingleOwner
        returns (bytes memory result)
    {
        if (to == address(this)) {
            _requireAllowedAdminSelector(data);
        }
        if (guard != address(0) && to != address(this)) IGuard(guard).check(to, value, data);
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed();
        if (guard != address(0) && to != address(this)) IGuard(guard).checkAfter(to, value, data, ret);
        emit Executed(to, value, data, ret);
        return ret;
    }

    function execute(Action calldata a, bytes[] calldata sigs)
        external
        payable
        nonReentrant
        returns (bytes memory result)
    {
        if (block.timestamp > a.deadline) revert DeadlineExpired();
        if (a.nonce != nonce) revert NonceInvalid();
        if (a.to == address(this)) {
            _requireAllowedAdminSelector(a.data);
        }
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(
                ACTION_TYPEHASH,
                a.to,
                a.value,
                keccak256(a.data),
                a.nonce,
                a.deadline
            ))
        );

        uint256 sigCount = sigs.length;
        if (sigCount < threshold) revert InsufficientSignatures();
        address last;
        uint256 valid;
        for (uint256 i = 0; i < sigCount; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            if (!isOwner[signer]) revert DuplicateOrInvalidSigner();
            if (i > 0 && signer <= last) revert DuplicateOrInvalidSigner();
            last = signer;
            unchecked { valid++; }
        }
        if (valid < threshold) revert InsufficientSignatures();

        nonce = a.nonce + 1;
        if (guard != address(0) && a.to != address(this)) IGuard(guard).check(a.to, a.value, a.data);
        (bool ok, bytes memory ret) = a.to.call{value: a.value}(a.data);
        if (!ok) revert CallFailed();
        if (guard != address(0) && a.to != address(this)) IGuard(guard).checkAfter(a.to, a.value, a.data, ret);
        emit Executed(a.to, a.value, a.data, ret);
        return ret;
    }

    // Execute a batch of calls atomically under one signature set and nonce.
    function executeBatch(
        address[] calldata to,
        uint256[] calldata value,
        bytes[] calldata data,
        uint256 deadline,
        bytes[] calldata sigs
    ) external payable nonReentrant returns (bytes[] memory results) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        uint256 len = to.length;
        if (len == 0 || len > MAX_BATCH || value.length != len || data.length != len) revert InvalidBatchLength();

        // Build EIP-712 hashes of arrays
        bytes32[] memory toLeaves = new bytes32[](len);
        bytes32[] memory valueLeaves = new bytes32[](len);
        bytes32[] memory dataLeaf = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            if (to[i] == address(this)) {
                _requireAllowedAdminSelector(data[i]);
            }
            toLeaves[i] = bytes32(uint256(uint160(to[i])));
            valueLeaves[i] = bytes32(value[i]);
            dataLeaf[i] = keccak256(data[i]);
        }
        bytes32 toHash = keccak256(abi.encodePacked(toLeaves));
        bytes32 valueHash = keccak256(abi.encodePacked(valueLeaves));
        bytes32 dataHash = keccak256(abi.encodePacked(dataLeaf));

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(
                BATCH_TYPEHASH,
                toHash,
                valueHash,
                dataHash,
                nonce,
                deadline
            ))
        );

        uint256 sigCount = sigs.length;
        if (sigCount < threshold) revert InsufficientSignatures();
        address last;
        uint256 valid;
        for (uint256 i = 0; i < sigCount; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            if (!isOwner[signer]) revert DuplicateOrInvalidSigner();
            if (i > 0 && signer <= last) revert DuplicateOrInvalidSigner();
            last = signer;
            unchecked { valid++; }
        }
        if (valid < threshold) revert InsufficientSignatures();

        uint256 current = nonce;
        nonce = current + 1;

        results = new bytes[](len);
        for (uint256 i = 0; i < len; i++) {
            if (guard != address(0) && to[i] != address(this)) IGuard(guard).check(to[i], value[i], data[i]);
            (bool ok, bytes memory ret) = to[i].call{value: value[i]}(data[i]);
            if (!ok) revert CallFailed();
            if (guard != address(0) && to[i] != address(this)) IGuard(guard).checkAfter(to[i], value[i], data[i], ret);
            emit Executed(to[i], value[i], data[i], ret);
            results[i] = ret;
        }
        emit BatchExecuted(len);
        return results;
    }

    // EIP-1271 signature validation over a pre-hashed message.
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        uint256 len = signature.length;
        if (len == 0 || len % 65 != 0) return 0xffffffff;
        uint256 sigsCount = len / 65;
        if (sigsCount < threshold) return 0xffffffff;
        address last;
        uint256 valid;
        for (uint256 i = 0; i < sigsCount; i++) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                let ofs := add(signature, add(32, mul(i, 65)))
                r := mload(ofs)
                s := mload(add(ofs, 32))
                v := byte(0, mload(add(ofs, 64)))
            }
            address signer = ECDSA.recover(hash, abi.encodePacked(r, s, v));
            if (!isOwner[signer]) return 0xffffffff;
            if (i > 0 && signer <= last) return 0xffffffff;
            last = signer;
            unchecked { valid++; }
        }
        if (valid < threshold) return 0xffffffff;
        return EIP1271_MAGICVALUE;
    }

    // Owner management (only via self-call with admin module for multisig, or single owner mode)
    function addOwner(address newOwner) external onlySelfOrSingleOwner {
        if (newOwner == address(0) || isOwner[newOwner]) revert InvalidOwners();
        if (owners.length + 1 > 5) revert InvalidOwners();
        isOwner[newOwner] = true;
        owners.push(newOwner);
        emit OwnerAdded(newOwner);
    }

    function removeOwner(address ownerToRemove) external onlySelfOrSingleOwner {
        if (!isOwner[ownerToRemove]) revert InvalidOwners();
        uint256 newCount = owners.length - 1;
        if (newCount < 1) revert InvalidOwners();
        if (threshold > newCount) {
            threshold = uint8(newCount);
            emit ThresholdChanged(uint8(newCount));
        }
        isOwner[ownerToRemove] = false;
        uint256 L = owners.length;
        for (uint256 i = 0; i < L; i++) {
            if (owners[i] == ownerToRemove) {
                owners[i] = owners[L - 1];
                owners.pop();
                break;
            }
        }
        emit OwnerRemoved(ownerToRemove);
    }

    function swapOwner(address oldOwner, address newOwner) external onlySelfOrSingleOwner {
        if (!isOwner[oldOwner] || newOwner == address(0) || isOwner[newOwner]) revert InvalidOwners();
        isOwner[oldOwner] = false;
        isOwner[newOwner] = true;
        uint256 L = owners.length;
        for (uint256 i = 0; i < L; i++) {
            if (owners[i] == oldOwner) { owners[i] = newOwner; break; }
        }
        emit OwnerSwapped(oldOwner, newOwner);
    }

    function changeThreshold(uint8 newThreshold) external onlySelfOrSingleOwner {
        if (newThreshold == 0 || newThreshold > owners.length) revert InvalidThreshold();
        threshold = newThreshold;
        emit ThresholdChanged(newThreshold);
    }

    function _requireAllowedAdminSelector(bytes calldata data) private pure {
        if (data.length < 4) revert InvalidSelector();
        bytes4 sel;
        assembly { sel := shr(224, calldataload(data.offset)) }
        if (
            sel != this.addOwner.selector &&
            sel != this.removeOwner.selector &&
            sel != this.swapOwner.selector &&
            sel != this.changeThreshold.selector &&
            sel != this.setGuard.selector &&
            sel != this.emergencyRemoveGuard.selector
        ) revert InvalidSelector();
    }

    receive() external payable {}

    // Helper: compute EIP-712 digest for a single Action (for off-chain signing/testing).
    function getActionDigest(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 nonce_,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ACTION_TYPEHASH,
                    to,
                    value,
                    keccak256(data),
                    nonce_,
                    deadline
                )
            )
        );
    }

    // Helper: compute EIP-712 digest for a batch using the current nonce.
    function getBatchDigest(
        address[] calldata to,
        uint256[] calldata value,
        bytes[] calldata data,
        uint256 deadline
    ) external view returns (bytes32) {
        uint256 len = to.length;
        bytes32[] memory toLeaves = new bytes32[](len);
        bytes32[] memory valueLeaves = new bytes32[](len);
        bytes32[] memory dataLeaf = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            toLeaves[i] = bytes32(uint256(uint160(to[i])));
            valueLeaves[i] = bytes32(value[i]);
            dataLeaf[i] = keccak256(data[i]);
        }
        bytes32 toHash = keccak256(abi.encodePacked(toLeaves));
        bytes32 valueHash = keccak256(abi.encodePacked(valueLeaves));
        bytes32 dataHash = keccak256(abi.encodePacked(dataLeaf));
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    BATCH_TYPEHASH,
                    toHash,
                    valueHash,
                    dataHash,
                    nonce,
                    deadline
                )
            )
        );
    }
}
