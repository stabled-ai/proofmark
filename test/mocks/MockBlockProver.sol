// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {INativeQueryVerifier} from "../../src/lib/VerifierInterface.sol";

/// @notice Mock of the BlockProver precompile at 0x...0FD2, injected with `vm.etch`.
/// @dev Pure, writes no state, so etching over empty storage is safe.
///      It lets the full ASC application path run without a public attestation wait.
contract MockBlockProver {
    /// @dev Always verifies. What we are testing is the ASC guard logic, not proof arithmetic.
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return true;
    }

    /// @dev Derives txIndex from merkleRoot, so different roots produce different queryIds.
    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata p) external pure returns (uint64) {
        return uint64(uint256(p.root) & 0xffffffff);
    }
}

/// @notice The failing-verification case
contract MockBlockProverFailing {
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return false;
    }

    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata p) external pure returns (uint64) {
        return uint64(uint256(p.root) & 0xffffffff);
    }
}
