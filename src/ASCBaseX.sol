// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {INativeQueryVerifier, NativeQueryVerifierLib} from "./lib/VerifierInterface.sol";

/// @title ASCBaseX
/// @notice A fork of Attestcoin's `ASCBase`. Proof verification, queryId derivation and replay
///         protection follow the original exactly; the handler additionally receives `chainKey`,
///         `blockHeight`, and the transaction index derived from the verified Merkle proof.
///
/// @dev Why the fork:
///  original: _processAndEmitEvent(action, queryId, encodedTransaction)
///  fork:     _processAndEmitEvent(action, chainKey, blockHeight, txIndex, encodedTransaction)
///
///  Without chainKey the handler cannot pin the source chain. CC3 Testnet supports chainKey 1
///  (Sepolia) and 3 (Ethereum mainnet) at the same time, so checking log.address_ alone still
///  accepts a forged event from a same-address contract on the other chain. CREATE2 deployment
///  makes that address collision cheap to arrange.
///
///  Without blockHeight and txIndex the handler cannot order anything. Proof submission is
///  permissionless and unordered, so an old MarkIssued submitted after a MarkRevoked can
///  resurrect a dead mark. txIndex also orders two source transactions in the same block.
///
///  The verification path itself (verifyAndEmit, _computeQueryId, processedQueries) is left
///  untouched.
abstract contract ASCBaseX {
    /// @notice BlockProver precompile at 0x...0FD2
    INativeQueryVerifier public immutable VERIFIER;

    /// @notice Replay guard. queryId = keccak256(chainKey, blockHeight, txIndex)
    mapping(bytes32 => bool) public processedQueries;

    error InvalidAction(uint8 action);

    constructor() {
        VERIFIER = NativeQueryVerifierLib.getVerifier();
    }

    /// @notice The only extension point a derived contract implements.
    /// @param action        Action code supplied by the caller, not derived from the proof.
    ///                      A mismatch must revert rather than fall through.
    /// @param chainKey      Source chain the proof verified against. Not present in the original.
    /// @param blockHeight   Source chain block height. Not present in the original.
    /// @param txIndex       Source transaction index derived from the Merkle proof.
    /// @param encodedTransaction ABI-encoded source transaction and receipt
    function _processAndEmitEvent(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        uint64 txIndex,
        bytes memory encodedTransaction
    ) internal virtual;

    /// @notice Verifies a proof and runs the action. Permissionless by design: anyone may call it.
    /// @dev A third party can push state forward when the issuer does not.
    function execute(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external returns (bool success) {
        {
            bytes32 queryId = _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);

            require(!processedQueries[queryId], "Query already processed");

            require(
                _verifyProof(
                    chainKey,
                    blockHeight,
                    encodedTransaction,
                    merkleRoot,
                    siblings,
                    lowerEndpointDigest,
                    continuityRoots
                ),
                "Proof of inclusion verification failed"
            );

            processedQueries[queryId] = true;
        }

        uint64 txIndex = _txIndex(merkleRoot, siblings);
        _processAndEmitEvent(action, chainKey, blockHeight, txIndex, encodedTransaction);

        return true;
    }

    function _verifyProof(
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) internal returns (bool verified) {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});

        INativeQueryVerifier.ContinuityProof memory continuityProof =
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots});

        verified = VERIFIER.verifyAndEmit(chainKey, blockHeight, encodedTransaction, merkleProof, continuityProof);
    }

    /// @dev Must stay byte-identical to the original ASCBase. Do not change.
    function _computeQueryId(
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) internal view returns (bytes32 queryId) {
        (queryId,) = _queryCoordinates(chainKey, blockHeight, merkleRoot, siblings);
    }

    function _txIndex(bytes32 merkleRoot, INativeQueryVerifier.MerkleProofEntry[] calldata siblings)
        private
        view
        returns (uint64)
    {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});
        return VERIFIER.calculateTxIndex(merkleProof);
    }

    /// @dev Returns the same queryId as upstream ASCBase plus the proven transaction index used
    ///      by subject-level ordering. The assembly byte layout must remain byte-identical.
    function _queryCoordinates(
        uint64 chainKey,
        uint64 blockHeight,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) private view returns (bytes32 queryId, uint64 txIndex) {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});

        txIndex = VERIFIER.calculateTxIndex(merkleProof);

        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainKey)
            mstore(add(ptr, 32), shl(192, blockHeight))
            mstore(add(ptr, 40), txIndex)
            queryId := keccak256(ptr, 72)
        }
    }
}
