// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFlashArbOwner {
    function owner() external view returns (address);
}

/// @notice Stable FlashArb address with atomic deployment of an approved implementation.
/// @dev Compatible implementations preserve the owner in persistent slot zero,
///      the execution lock in transient slot zero, and the V3 execute selector.
contract FlashArbProxy {
    bytes32 private constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 private constant ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);
    // execute((uint8,address,(uint8,address,uint24,int24,bool),(uint8,address,uint24,int24,bool),uint256,uint256,uint256,uint256))
    bytes4 private constant EXECUTE_SELECTOR = 0x83cf854d;

    address private routeOwner; // Slot zero is shared with FlashArbV3.owner.

    error Unauthorized();
    error Busy();
    error WrongImplementation();
    error DeploymentFailed();
    error IncompatibleOwner();
    error InvalidExecution();

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    constructor(bytes memory initialCode, bytes32 initialCodeHash) {
        routeOwner = msg.sender;
        _setAddress(ADMIN_SLOT, msg.sender);
        emit AdminChanged(address(0), msg.sender);
        _install(initialCode, initialCodeHash, msg.sender, msg.sender);
    }

    function upgradeAdmin() external view returns (address) {
        return _getAddress(ADMIN_SLOT);
    }

    /// @notice Create and activate a release together. A raced or invalid release leaves the old one active.
    function upgradeRelease(bytes calldata creationCode, bytes32 expectedPreviousCodeHash, bytes32 expectedNewCodeHash)
        external returns (address implementation)
    {
        address admin = _getAddress(ADMIN_SLOT);
        if (msg.sender != admin) revert Unauthorized();
        address previous = _getAddress(IMPLEMENTATION_SLOT);
        if (previous.codehash != expectedPreviousCodeHash || expectedPreviousCodeHash == expectedNewCodeHash) {
            revert WrongImplementation();
        }
        uint256 lock;
        assembly ("memory-safe") { lock := tload(0) }
        if (lock != 0) revert Busy();
        assembly ("memory-safe") { tstore(0, 1) }
        implementation = _install(creationCode, expectedNewCodeHash, admin, routeOwner);
        assembly ("memory-safe") { tstore(0, 0) }
    }

    /// @notice Execute only against the runtime that was quoted and simulated.
    function executePinned(bytes32 expectedCodeHash, bytes calldata data) external returns (uint256) {
        if (msg.sender != routeOwner) revert Unauthorized();
        if (data.length < 4 || bytes4(data[:4]) != EXECUTE_SELECTOR) revert InvalidExecution();
        address implementation = _getAddress(IMPLEMENTATION_SLOT);
        if (implementation.codehash != expectedCodeHash) revert WrongImplementation();
        (bool ok, bytes memory result) = implementation.delegatecall(data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        return abi.decode(result, (uint256));
    }

    fallback() external payable {
        if (msg.sig == EXECUTE_SELECTOR) revert InvalidExecution();
        _forward();
    }

    receive() external payable {
        _forward();
    }

    function _install(bytes memory creationCode, bytes32 expectedCodeHash, address admin, address owner)
        private returns (address implementation)
    {
        assembly ("memory-safe") { implementation := create(0, add(creationCode, 32), mload(creationCode)) }
        if (implementation.code.length == 0) revert DeploymentFailed();
        if (implementation.codehash != expectedCodeHash) revert WrongImplementation();

        _setAddress(IMPLEMENTATION_SLOT, implementation);
        (bool ok, bytes memory result) = implementation.delegatecall(abi.encodeCall(IFlashArbOwner.owner, ()));
        if (!ok || result.length != 32 || abi.decode(result, (address)) != owner || routeOwner != owner
            || _getAddress(ADMIN_SLOT) != admin || _getAddress(IMPLEMENTATION_SLOT) != implementation) {
            revert IncompatibleOwner();
        }
        emit Upgraded(implementation);
    }

    function _forward() private {
        address implementation = _getAddress(IMPLEMENTATION_SLOT);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    function _getAddress(bytes32 slot) private view returns (address value) {
        assembly ("memory-safe") { value := sload(slot) }
    }

    function _setAddress(bytes32 slot, address value) private {
        assembly ("memory-safe") { sstore(slot, value) }
    }
}
