// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

import {ASCBaseX} from "./ASCBaseX.sol";
import {MarkAttrs} from "./lib/MarkAttrs.sol";
import {EpochBounds} from "./lib/EpochBounds.sol";
import {Action, Mark, MarkStatus, MarkOrigin} from "./lib/ProofmarkTypes.sol";

/// @title ProofmarkASC
/// @notice The chain of record, deployed on Creditcoin CC3. Verifies marks issued on Ethereum
///         through the USC BlockProver and materialises them into state.
///
/// Deployment requires linking the `EvmV1Decoder` library. See the note below.
//
//  forge create --broadcast --rpc-url $CREDITCOIN_RPC_URL --private-key $KEY \
//    --libraries node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder:<LIB_ADDR> \
//    src/ProofmarkASC.sol:ProofmarkASC --constructor-args <OWNER>
//
//  Use a LIB_ADDR you deployed yourself. The "Decoder Contract" listed for CC3 Testnet
//  (0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f) has a different runtime size from our build
//  (19,199 vs 26,524 hex chars), so we have not confirmed it is the same library. A bad link
//  fails quietly and costs an eight-minute attestation cycle to discover.
contract ProofmarkASC is Ownable2Step, ASCBaseX {
    using MarkAttrs for bytes32;

    /// @notice v2 consumes every trusted lifecycle log atomically, not only the caller's action.
    uint256 public constant TRANSACTION_PROCESSING_VERSION = 2;
    uint256 public constant ATTRS_SCHEMA_VERSION = 0;
    uint256 public constant EPOCH_SCHEMA_VERSION = 2;
    uint256 public constant ROSTER_AUTH_VERSION = 1;
    uint256 public constant ISSUER_KEY_PROVENANCE_VERSION = 1;
    uint256 public constant DENIAL_CORRECTION_VERSION = 1;
    uint256 public constant MAX_EPOCH_AGE = EpochBounds.MAX_AGE;

    // Event signatures, computed with cast keccak from ComplianceSource.
    bytes32 internal constant SIG_ISSUED = 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3;
    bytes32 internal constant SIG_KEYED_ISSUED =
        keccak256("KeyedMarkIssued(address,bytes32,address,uint64,bytes32,bytes32)");
    bytes32 internal constant SIG_REVOKED = 0xdde75c52928e1a0e5b14011716a8309ab432e435d50ced197b667cc906d3fd09;
    bytes32 internal constant SIG_DENIED = 0x4e68a53405a08cc0e2bb7cd374ad540457f069bcf32e0830ea2e851815d6f5ae;
    bytes32 internal constant SIG_EPOCH =
        keccak256("RosterEpochPublished(uint32,bytes32,uint32,uint40,uint40,uint40,bytes32)");
    bytes32 internal constant SIG_KEY_COMPROMISED = keccak256("IssuerKeyCompromised(address,uint64,uint64,bytes32)");
    bytes32 internal constant SIG_KEYED_EPOCH_AUTH =
        keccak256("RosterIssuerKeyAuthorized(uint32,bytes32,address,uint64)");
    bytes32 internal constant SIG_DENIAL_CORRECTED =
        keccak256("SanctionDenialCorrected(address,uint64,uint256,bytes32,address,address)");

    // Source pinning, checks 1 and 4
    /// @notice The one source chain accepted. CC3 Testnet serves both 1 (Sepolia) and 3 (Ethereum).
    uint64 public expectedChainKey;
    /// @notice The only contract whose events this ASC will act on.
    address public sourceContract;

    // State
    mapping(address => Mark) public marks;
    /// @notice Revocation and sanction tombstones. Outrank every epoch root: deny beats allow.
    mapping(address => bool) public tombstone;
    /// @notice Monotonic sanctions state, independent of the latest ordinary event cursor.
    ///         A valid denial applies even when a newer issuance was proved first.
    mapping(address => bool) public permanentDenial;
    /// @notice Ordering cursor, check 5. Height/transaction index order source transactions;
    ///         lastAppliedLogIndex orders repeated subjects inside one receipt.
    mapping(address => uint64) public lastAppliedHeight;
    mapping(address => uint64) public lastAppliedTxIndex;
    /// @notice Receipt-local log position breaks ties within one source transaction.
    mapping(address => uint256) public lastAppliedLogIndex;
    /// @notice Stable-issuer key generation authenticated by a keyed source event. Zero is legacy.
    mapping(address => uint64) public markIssuerKeyEpoch;
    /// @notice Source-order cursor for deny/correct decisions. It is separate from ordinary
    ///         issuance/revocation ordering so a late proof cannot erase a newer decision.
    mapping(address => uint64) public lastDenialDecisionHeight;
    mapping(address => uint64) public lastDenialDecisionTxIndex;
    mapping(address => uint256) public lastDenialDecisionLogIndex;
    /// @notice Source-ordered ordinary transition retained while a denial masks the visible mark.
    ///         The boolean is kept for ABI compatibility; this status distinguishes revocation
    ///         from malformed-issuance suspension when a later correction is relayed out of order.
    mapping(address => uint8) public latestOrdinaryStatus;
    mapping(address => bool) public latestOrdinaryIsIssuance;
    mapping(address => uint64) public lastCorrectedDenialRevision;
    mapping(address => uint256) public lastDenialCorrectionId;
    mapping(address => bytes32) public lastDenialCorrectionReasonHash;
    mapping(address => address) public lastDenialCorrectionProposer;
    mapping(address => address) public lastDenialCorrectionApprover;

    mapping(uint32 => bytes32) public epochRoots;
    mapping(uint32 => mapping(address => bool)) public epochIssuerApproved;
    mapping(uint32 => mapping(address => uint64)) public epochIssuerKeyEpoch;
    mapping(uint32 => mapping(address => uint64)) public epochIssuerApprovalHeight;
    mapping(address => mapping(uint64 => bool)) public issuerKeyCompromised;
    mapping(address => mapping(uint64 => uint64)) public issuerKeyLastTrustedBlock;
    uint32 public latestEpoch;
    uint40 public epochValidUntil;
    uint40 public epochSourceCutoff;
    uint40 public epochPublishedAt;
    uint32 public epochListVersion;
    bytes32 public epochSnapshotId;

    event SourceConfigured(uint64 chainKey, address sourceContract);
    event MarkMaterialized(address indexed subject, bytes32 attrs, uint64 blockHeight, uint64 txIndex);
    event MarkTombstoned(address indexed subject, uint8 status, uint64 blockHeight, uint64 txIndex);
    event MarkReactivated(address indexed subject, uint64 blockHeight, uint64 txIndex);
    event EpochAccepted(uint32 indexed epoch, bytes32 root, uint40 validUntil);
    event EpochProvenance(
        uint32 indexed epoch, uint40 sourceCutoff, uint40 publishedAt, uint32 listVersion, bytes32 snapshotId
    );
    event StaleEpochSkipped(uint32 indexed epoch, uint32 latest);
    event StaleProofSkipped(
        address indexed subject, uint64 blockHeight, uint64 txIndex, uint64 lastHeight, uint64 lastTxIndex
    );
    event PermanentDenialSkipped(address indexed subject, uint64 blockHeight, uint64 txIndex);
    event IssuerKeyCutoffAccepted(
        address indexed issuer, uint64 indexed issuerKeyEpoch, uint64 lastTrustedBlock, bytes32 reasonHash
    );
    event DenialCorrectionAccepted(
        address indexed subject,
        uint64 indexed denialRevision,
        uint256 indexed correctionId,
        bytes32 reasonHash,
        address proposer,
        address approver
    );
    event StaleDenialDecisionSkipped(
        address indexed subject,
        uint64 blockHeight,
        uint64 txIndex,
        uint256 logIndex,
        uint64 lastHeight,
        uint64 lastTxIndex,
        uint256 lastLogIndex
    );

    error SourceNotConfigured();
    error UnexpectedChainKey(uint64 got, uint64 want);
    error UntrustedEmitter(address got, address want);
    error SourceTxFailed();
    error NoMatchingEvent();
    error BadTopics();
    error EpochNotMonotonic(uint32 given, uint32 latest);
    error SourceAlreadyConfigured();
    error InvalidEpoch();
    error InvalidEpochAuthorization();
    error InvalidIssuerKeyProvenance();
    error InvalidDenialCorrection();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Pins the source chain and contract. No proof is accepted before this is set.
    function configureSource(uint64 chainKey_, address sourceContract_) external onlyOwner {
        if (sourceContract != address(0)) revert SourceAlreadyConfigured();
        require(sourceContract_ != address(0), "zero source");
        require(chainKey_ != 0, "zero chainKey");
        expectedChainKey = chainKey_;
        sourceContract = sourceContract_;
        emit SourceConfigured(chainKey_, sourceContract_);
    }

    // ASCBaseX extension point

    function _processAndEmitEvent(
        uint8 action,
        uint64 chainKey,
        uint64 blockHeight,
        uint64 txIndex,
        bytes memory encodedTx
    ) internal override {
        if (sourceContract == address(0)) revert SourceNotConfigured();
        // 1. pin the source chain. Without this an Ethereum mainnet proof passes. docs/05 section 1
        if (chainKey != expectedChainKey) revert UnexpectedChainKey(chainKey, expectedChainKey);

        if (action > uint8(Action.SanctionDenialCorrection)) revert InvalidAction(action);
        uint8 t = EvmV1Decoder.getTransactionType(encodedTx);
        require(EvmV1Decoder.isValidTransactionType(t), "bad tx type");
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encodedTx);
        if (r.receiptStatus != 1) revert SourceTxFailed();

        bytes32 requested = action == 0
            ? SIG_ISSUED
            : action == 1
                ? SIG_REVOKED
                : action == 2
                    ? SIG_DENIED
                    : action == 3 ? SIG_EPOCH : action == 4 ? SIG_KEY_COMPROMISED : SIG_DENIAL_CORRECTED;
        bool matched;
        EvmV1Decoder.LogEntry[] memory single = new EvmV1Decoder.LogEntry[](1);
        for (uint256 i; i < r.receiptLogs.length; ++i) {
            EvmV1Decoder.LogEntry memory L = r.receiptLogs[i];
            // Foreign contracts may emit identical signatures in a multicall. They have no
            // authority here and must neither change state nor suppress trusted source logs.
            if (L.address_ != sourceContract || L.topics.length == 0) continue;
            bytes32 sig = L.topics[0];
            if (sig == requested || (action == uint8(Action.MarkIssued) && sig == SIG_KEYED_ISSUED)) matched = true;
            single[0] = L;
            if (sig == SIG_ISSUED) _onIssued(blockHeight, txIndex, i, single);
            else if (sig == SIG_KEYED_ISSUED) _onKeyedIssued(blockHeight, txIndex, i, single);
            else if (sig == SIG_REVOKED) _onTombstone(blockHeight, txIndex, i, single, uint8(MarkStatus.Revoked));
            else if (sig == SIG_DENIED) _onTombstone(blockHeight, txIndex, i, single, uint8(MarkStatus.Denied));
            else if (sig == SIG_EPOCH) _onEpoch(blockHeight, single, r.receiptLogs);
            else if (sig == SIG_KEY_COMPROMISED) _onKeyCompromised(blockHeight, single);
            else if (sig == SIG_DENIAL_CORRECTED) _onDenialCorrected(blockHeight, txIndex, i, single);
        }
        // Keep the existing execute ABI and reject an absent action. A present action is only
        // a hint: permissionless callers cannot choose which other lifecycle logs get omitted.
        if (!matched) revert NoMatchingEvent();
    }

    /// @dev 4. emitter check. Without it anyone can prove a forged event and get it accepted.
    function _requireTrusted(EvmV1Decoder.LogEntry memory L, uint256 expectedTopics) private view {
        if (L.address_ != sourceContract) revert UntrustedEmitter(L.address_, sourceContract);
        if (L.topics.length != expectedTopics) revert BadTopics();
    }

    // Handlers

    /// @dev 3. walk every matching log, so one execute() applies N entries from a single tx. docs/05 section 3
    function _onIssued(uint64 blockHeight, uint64 txIndex, uint256 logIndex, EvmV1Decoder.LogEntry[] memory logs)
        private
    {
        uint256 n = logs.length;
        for (uint256 i = 0; i < n; ++i) {
            EvmV1Decoder.LogEntry memory L = logs[i];
            _requireTrusted(L, 4); // sig + subject + attrs + issuer

            address subject = address(uint160(uint256(L.topics[1])));
            bytes32 attrs = L.topics[2];
            address issuer = address(uint160(uint256(L.topics[3])));
            (bytes32 claimsRoot, bytes32 evidenceHash) = abi.decode(L.data, (bytes32, bytes32));

            // 5. ordering guard: an older issuance must not overwrite a newer revocation
            if (!_advance(subject, blockHeight, txIndex, logIndex)) continue;

            // A normal revocation can be cured by a later full KYC issuance. A sanctions denial
            // cannot: only the separately approved correction event can supersede it.
            if (permanentDenial[subject]) {
                if (MarkAttrs.validSchema(attrs)) {
                    _storeMark(subject, attrs, issuer, claimsRoot, evidenceHash);
                    marks[subject].status = uint8(MarkStatus.Denied);
                    markIssuerKeyEpoch[subject] = 0;
                    latestOrdinaryStatus[subject] = uint8(MarkStatus.Active);
                    latestOrdinaryIsIssuance[subject] = true;
                } else {
                    latestOrdinaryStatus[subject] = uint8(MarkStatus.Suspended);
                    latestOrdinaryIsIssuance[subject] = false;
                }
                tombstone[subject] = true;
                emit PermanentDenialSkipped(subject, blockHeight, txIndex);
                continue;
            }
            // Old sources may have emitted an unsupported schema. Suspend the subject rather
            // than retaining a previous valid mark or reverting a denial sharing this receipt.
            if (!MarkAttrs.validSchema(attrs)) {
                tombstone[subject] = true;
                marks[subject].status = uint8(MarkStatus.Suspended);
                latestOrdinaryStatus[subject] = uint8(MarkStatus.Suspended);
                latestOrdinaryIsIssuance[subject] = false;
                emit MarkTombstoned(subject, uint8(MarkStatus.Suspended), blockHeight, txIndex);
                continue;
            }
            bool reactivated = tombstone[subject];
            tombstone[subject] = false;

            _storeMark(subject, attrs, issuer, claimsRoot, evidenceHash);
            markIssuerKeyEpoch[subject] = 0;
            latestOrdinaryStatus[subject] = uint8(MarkStatus.Active);
            latestOrdinaryIsIssuance[subject] = true;
            if (reactivated) emit MarkReactivated(subject, blockHeight, txIndex);
            emit MarkMaterialized(subject, attrs, blockHeight, txIndex);
        }
    }

    function _onKeyedIssued(uint64 blockHeight, uint64 txIndex, uint256 logIndex, EvmV1Decoder.LogEntry[] memory logs)
        private
    {
        EvmV1Decoder.LogEntry memory L = logs[0];
        _requireTrusted(L, 4);
        if (L.data.length != 96) revert InvalidIssuerKeyProvenance();
        address subject = address(uint160(uint256(L.topics[1])));
        bytes32 attrs = L.topics[2];
        address issuer = address(uint160(uint256(L.topics[3])));
        (uint64 issuerKeyEpoch, bytes32 claimsRoot, bytes32 evidenceHash) =
            abi.decode(L.data, (uint64, bytes32, bytes32));
        if (issuerKeyEpoch == 0) revert InvalidIssuerKeyProvenance();
        if (!_advance(subject, blockHeight, txIndex, logIndex)) return;
        if (permanentDenial[subject]) {
            if (MarkAttrs.validSchema(attrs)) {
                _storeMark(subject, attrs, issuer, claimsRoot, evidenceHash);
                marks[subject].status = uint8(MarkStatus.Denied);
                markIssuerKeyEpoch[subject] = issuerKeyEpoch;
                latestOrdinaryStatus[subject] = uint8(MarkStatus.Active);
                latestOrdinaryIsIssuance[subject] = true;
            } else {
                latestOrdinaryStatus[subject] = uint8(MarkStatus.Suspended);
                latestOrdinaryIsIssuance[subject] = false;
            }
            tombstone[subject] = true;
            emit PermanentDenialSkipped(subject, blockHeight, txIndex);
            return;
        }
        if (!MarkAttrs.validSchema(attrs)) {
            tombstone[subject] = true;
            marks[subject].status = uint8(MarkStatus.Suspended);
            latestOrdinaryStatus[subject] = uint8(MarkStatus.Suspended);
            latestOrdinaryIsIssuance[subject] = false;
            emit MarkTombstoned(subject, uint8(MarkStatus.Suspended), blockHeight, txIndex);
            return;
        }
        bool reactivated = tombstone[subject];
        tombstone[subject] = false;
        _storeMark(subject, attrs, issuer, claimsRoot, evidenceHash);
        markIssuerKeyEpoch[subject] = issuerKeyEpoch;
        latestOrdinaryStatus[subject] = uint8(MarkStatus.Active);
        latestOrdinaryIsIssuance[subject] = true;
        if (reactivated) emit MarkReactivated(subject, blockHeight, txIndex);
        emit MarkMaterialized(subject, attrs, blockHeight, txIndex);
    }

    function _storeMark(address subject, bytes32 attrs, address issuer, bytes32 claimsRoot, bytes32 evidenceHash)
        private
    {
        marks[subject] = Mark({
            status: uint8(MarkStatus.Active),
            // Direct, because this is the individual-proof path. Only Mode B sets Roster.
            origin: uint8(MarkOrigin.Direct),
            kind: attrs.kind(),
            assurance: attrs.assurance(),
            regime: attrs.regime(),
            jurisdiction: attrs.jurisdiction(),
            methods: attrs.methods(),
            issuedAt: attrs.issuedAt(),
            expiry: attrs.expiry(),
            epoch: attrs.epoch(),
            claimsRoot: claimsRoot,
            evidenceHash: evidenceHash,
            issuer: issuer
        });
    }

    /// @dev Revocation and sanction share a shape (4 topics, no data), so one handler covers both.
    function _onTombstone(
        uint64 blockHeight,
        uint64 txIndex,
        uint256 logIndex,
        EvmV1Decoder.LogEntry[] memory logs,
        uint8 newStatus
    ) private {
        uint256 n = logs.length;
        for (uint256 i = 0; i < n; ++i) {
            EvmV1Decoder.LogEntry memory L = logs[i];
            _requireTrusted(L, 4);

            address subject = address(uint160(uint256(L.topics[1])));

            if (newStatus == uint8(MarkStatus.Denied)) {
                // Denial is cumulative, not latest-wins. A relay (or any caller) may deliver
                // this proof after a later issue/revoke. A newer governed correction is the only
                // sanctions decision that can supersede it.
                if (!_advanceDenialDecision(subject, blockHeight, txIndex, logIndex)) continue;
                permanentDenial[subject] = true;
                if (_isNewer(subject, blockHeight, txIndex, logIndex)) {
                    _advance(subject, blockHeight, txIndex, logIndex);
                }
            } else if (!_advance(subject, blockHeight, txIndex, logIndex)) {
                continue;
            } else {
                latestOrdinaryStatus[subject] = uint8(MarkStatus.Revoked);
                latestOrdinaryIsIssuance[subject] = false;
            }

            tombstone[subject] = true;
            // Once denied, a later ordinary revocation must not downgrade the permanent denial
            // into the reissuable Revoked state.
            marks[subject].status = permanentDenial[subject] ? uint8(MarkStatus.Denied) : newStatus;

            emit MarkTombstoned(subject, marks[subject].status, blockHeight, txIndex);
        }
    }

    function _onDenialCorrected(
        uint64 blockHeight,
        uint64 txIndex,
        uint256 logIndex,
        EvmV1Decoder.LogEntry[] memory logs
    ) private {
        EvmV1Decoder.LogEntry memory L = logs[0];
        _requireTrusted(L, 4);
        if (
            L.data.length != 96 || uint256(L.topics[1]) > type(uint160).max || uint256(L.topics[2]) == 0
                || uint256(L.topics[2]) > type(uint64).max || uint256(L.topics[3]) == 0
        ) revert InvalidDenialCorrection();
        address subject = address(uint160(uint256(L.topics[1])));
        uint64 denialRevision = uint64(uint256(L.topics[2]));
        uint256 correctionId = uint256(L.topics[3]);
        (bytes32 reasonHash, address proposer, address approver) = abi.decode(L.data, (bytes32, address, address));
        if (
            subject == address(0) || reasonHash == bytes32(0) || proposer == address(0) || approver == address(0)
                || proposer == approver
        ) revert InvalidDenialCorrection();
        if (!_advanceDenialDecision(subject, blockHeight, txIndex, logIndex)) return;

        permanentDenial[subject] = false;
        lastCorrectedDenialRevision[subject] = denialRevision;
        lastDenialCorrectionId[subject] = correctionId;
        lastDenialCorrectionReasonHash[subject] = reasonHash;
        lastDenialCorrectionProposer[subject] = proposer;
        lastDenialCorrectionApprover[subject] = approver;

        // A later ordinary issuance can be delivered before this correction receipt. It is kept
        // blocked while denial is active, then becomes usable only when source ordering proves it
        // followed this correction. Otherwise correction alone leaves the subject suspended until
        // the replacement MarkIssued log from the same source receipt is processed.
        bool laterOrdinary = !_isNewer(subject, blockHeight, txIndex, logIndex);
        if (laterOrdinary) {
            uint8 ordinaryStatus = latestOrdinaryStatus[subject];
            if (ordinaryStatus == uint8(MarkStatus.Active)) {
                tombstone[subject] = false;
                marks[subject].status = ordinaryStatus;
                emit MarkReactivated(subject, blockHeight, txIndex);
            } else {
                // Preserve the actual source-later ordinary transition. In particular, a
                // revocation is not the same state as an invalid issuance suspension.
                tombstone[subject] = true;
                marks[subject].status =
                    ordinaryStatus == uint8(MarkStatus.Revoked) ? ordinaryStatus : uint8(MarkStatus.Suspended);
                emit MarkTombstoned(subject, marks[subject].status, blockHeight, txIndex);
            }
        } else {
            _advance(subject, blockHeight, txIndex, logIndex);
            tombstone[subject] = true;
            marks[subject].status = uint8(MarkStatus.Suspended);
            emit MarkTombstoned(subject, uint8(MarkStatus.Suspended), blockHeight, txIndex);
        }
        emit DenialCorrectionAccepted(subject, denialRevision, correctionId, reasonHash, proposer, approver);
    }

    function _advanceDenialDecision(address subject, uint64 blockHeight, uint64 txIndex, uint256 logIndex)
        private
        returns (bool)
    {
        uint64 lastHeight = lastDenialDecisionHeight[subject];
        uint64 lastTx = lastDenialDecisionTxIndex[subject];
        uint256 lastLog = lastDenialDecisionLogIndex[subject];
        bool newer = blockHeight > lastHeight
            || (blockHeight == lastHeight && (txIndex > lastTx || (txIndex == lastTx && logIndex > lastLog)));
        if (!newer) {
            emit StaleDenialDecisionSkipped(subject, blockHeight, txIndex, logIndex, lastHeight, lastTx, lastLog);
            return false;
        }
        lastDenialDecisionHeight[subject] = blockHeight;
        lastDenialDecisionTxIndex[subject] = txIndex;
        lastDenialDecisionLogIndex[subject] = logIndex;
        return true;
    }

    function _advance(address subject, uint64 blockHeight, uint64 txIndex, uint256 logIndex) private returns (bool) {
        uint64 lastHeight = lastAppliedHeight[subject];
        uint64 lastTx = lastAppliedTxIndex[subject];
        if (!_isNewer(subject, blockHeight, txIndex, logIndex)) {
            emit StaleProofSkipped(subject, blockHeight, txIndex, lastHeight, lastTx);
            return false;
        }
        lastAppliedHeight[subject] = blockHeight;
        lastAppliedTxIndex[subject] = txIndex;
        lastAppliedLogIndex[subject] = logIndex;
        return true;
    }

    function _isNewer(address subject, uint64 blockHeight, uint64 txIndex, uint256 logIndex)
        private
        view
        returns (bool)
    {
        uint64 lastHeight = lastAppliedHeight[subject];
        return blockHeight > lastHeight
            || (blockHeight == lastHeight
                && (txIndex > lastAppliedTxIndex[subject]
                    || (txIndex == lastAppliedTxIndex[subject] && logIndex > lastAppliedLogIndex[subject])));
    }

    /// @dev All epoch logs are processed. An old epoch cannot prevent another lifecycle event
    ///      in the same receipt from being applied when proofs arrive out of order.
    function _onEpoch(
        uint64 blockHeight,
        EvmV1Decoder.LogEntry[] memory logs,
        EvmV1Decoder.LogEntry[] memory receiptLogs
    ) private {
        EvmV1Decoder.LogEntry memory L = logs[0];
        _requireTrusted(L, 4); // sig + epoch + root + listVersion

        if (uint256(L.topics[1]) > type(uint32).max || uint256(L.topics[3]) > type(uint32).max || L.data.length != 128) revert InvalidEpoch();
        uint32 epoch = uint32(uint256(L.topics[1]));
        bytes32 root = L.topics[2];
        (uint40 validUntil, uint40 cutoff, uint40 publishedAt, bytes32 snapshotId) =
            abi.decode(L.data, (uint40, uint40, uint40, bytes32));
        if (!EpochBounds.valid(root, cutoff, publishedAt, validUntil, snapshotId) || publishedAt > block.timestamp) {
            revert InvalidEpoch();
        }

        if (epoch <= latestEpoch) {
            emit StaleEpochSkipped(epoch, latestEpoch);
            return;
        }

        // Authorization is part of this proved receipt, never inferred from a caller-supplied
        // leaf or a separately replayable side event. Old unsigned epoch receipts are rejected.
        uint256 approved;
        for (uint256 i; i < receiptLogs.length; ++i) {
            EvmV1Decoder.LogEntry memory a = receiptLogs[i];
            if (
                a.address_ != sourceContract || a.topics.length == 0
                    || a.topics[0] != keccak256("RosterIssuerAuthorized(uint32,bytes32,address)")
            ) continue;
            if (
                a.topics.length != 4 || a.data.length != 0 || uint256(a.topics[1]) > type(uint32).max
                    || uint256(a.topics[3]) > type(uint160).max
            ) revert InvalidEpochAuthorization();
            if (a.topics[1] != bytes32(uint256(epoch)) || a.topics[2] != root) continue;
            address issuer = address(uint160(uint256(a.topics[3])));
            if (issuer == address(0) || epochIssuerApproved[epoch][issuer] || ++approved > 16) {
                revert InvalidEpochAuthorization();
            }
            epochIssuerApproved[epoch][issuer] = true;
            epochIssuerApprovalHeight[epoch][issuer] = blockHeight;
            uint64 issuerKeyEpoch;
            for (uint256 j; j < receiptLogs.length; ++j) {
                EvmV1Decoder.LogEntry memory keyed = receiptLogs[j];
                if (
                    keyed.address_ != sourceContract || keyed.topics.length == 0
                        || keyed.topics[0] != SIG_KEYED_EPOCH_AUTH
                ) continue;
                if (keyed.topics.length != 4 || keyed.data.length != 32) revert InvalidEpochAuthorization();
                if (keyed.topics[1] != bytes32(uint256(epoch)) || keyed.topics[2] != root) continue;
                if (address(uint160(uint256(keyed.topics[3]))) != issuer) continue;
                uint256 decodedEpoch = abi.decode(keyed.data, (uint256));
                if (issuerKeyEpoch != 0 || decodedEpoch == 0 || decodedEpoch > type(uint64).max) {
                    revert InvalidEpochAuthorization();
                }
                issuerKeyEpoch = uint64(decodedEpoch);
            }
            epochIssuerKeyEpoch[epoch][issuer] = issuerKeyEpoch;
        }
        if (approved == 0) revert InvalidEpochAuthorization();

        epochRoots[epoch] = root;
        latestEpoch = epoch;
        epochValidUntil = validUntil;
        epochSourceCutoff = cutoff;
        epochPublishedAt = publishedAt;
        epochListVersion = uint32(uint256(L.topics[3]));
        epochSnapshotId = snapshotId;

        emit EpochAccepted(epoch, root, validUntil);
        emit EpochProvenance(epoch, cutoff, publishedAt, epochListVersion, snapshotId);
    }

    function _onKeyCompromised(uint64 declarationHeight, EvmV1Decoder.LogEntry[] memory logs) private {
        EvmV1Decoder.LogEntry memory L = logs[0];
        _requireTrusted(L, 3);
        if (L.data.length != 64 || uint256(L.topics[1]) > type(uint160).max || uint256(L.topics[2]) > type(uint64).max)
        {
            revert InvalidIssuerKeyProvenance();
        }
        address issuer = address(uint160(uint256(L.topics[1])));
        uint64 issuerKeyEpoch = uint64(uint256(L.topics[2]));
        (uint64 lastTrustedBlock, bytes32 reasonHash) = abi.decode(L.data, (uint64, bytes32));
        if (
            issuer == address(0) || issuerKeyEpoch == 0 || reasonHash == bytes32(0)
                || lastTrustedBlock >= declarationHeight
        ) revert InvalidIssuerKeyProvenance();
        uint64 previous = issuerKeyLastTrustedBlock[issuer][issuerKeyEpoch];
        if (!issuerKeyCompromised[issuer][issuerKeyEpoch] || lastTrustedBlock < previous) {
            issuerKeyCompromised[issuer][issuerKeyEpoch] = true;
            issuerKeyLastTrustedBlock[issuer][issuerKeyEpoch] = lastTrustedBlock;
            emit IssuerKeyCutoffAccepted(issuer, issuerKeyEpoch, lastTrustedBlock, reasonHash);
        }
    }

    // Views

    function getMark(address subject) external view returns (Mark memory) {
        return marks[subject];
    }

    function isMarkIssuerUsable(address subject) external view returns (bool) {
        uint64 issuerKeyEpoch = markIssuerKeyEpoch[subject];
        address issuer = marks[subject].issuer;
        return issuerKeyEpoch == 0 || !issuerKeyCompromised[issuer][issuerKeyEpoch]
            || lastAppliedHeight[subject] <= issuerKeyLastTrustedBlock[issuer][issuerKeyEpoch];
    }

    function isEpochIssuerUsable(uint32 epoch, address issuer) public view returns (bool) {
        if (!epochIssuerApproved[epoch][issuer]) return false;
        uint64 issuerKeyEpoch = epochIssuerKeyEpoch[epoch][issuer];
        return issuerKeyEpoch == 0 || !issuerKeyCompromised[issuer][issuerKeyEpoch]
            || epochIssuerApprovalHeight[epoch][issuer] <= issuerKeyLastTrustedBlock[issuer][issuerKeyEpoch];
    }

    /// @notice Whether the roster itself is fresh. Once it expires nobody verifies. There is no
    ///         "unknown means allowed" here.
    function isRosterFresh() public view returns (bool) {
        return EpochBounds.valid(
            epochRoots[latestEpoch], epochSourceCutoff, epochPublishedAt, epochValidUntil, epochSnapshotId
        ) && epochPublishedAt <= block.timestamp && block.timestamp < epochValidUntil;
    }
}
