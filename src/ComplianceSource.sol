// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MarkAttrs} from "./lib/MarkAttrs.sol";
import {EpochBounds} from "./lib/EpochBounds.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title ComplianceSource
/// @notice The origin of issuance, deployed on Ethereum Sepolia. Emits only purpose-built events meant to be read cross-chain.
///
/// ASC v2 atomically consumes every trusted lifecycle event in receipt order. A contract issuer
/// may batch different calls or repeat a subject; the last ordinary event wins, while denial is
/// permanent. This is NOT safe with the historical action-filtered ASC v1: migrate before batching.
contract ComplianceSource is Ownable2Step, EIP712 {
    uint256 public constant ATTRS_SCHEMA_VERSION = 0;
    uint256 public constant EPOCH_SCHEMA_VERSION = 2;
    uint256 public constant ROSTER_AUTH_VERSION = 1;
    uint256 public constant ISSUER_KEY_PROVENANCE_VERSION = 1;
    uint256 public constant DENIAL_CORRECTION_VERSION = 1;
    uint40 public constant MIN_DENIAL_CORRECTION_DELAY = 1 hours;
    uint256 public constant MAX_ROSTER_ISSUERS = 16;
    bytes32 public constant ROSTER_APPROVAL_TYPEHASH = keccak256(
        "RosterApproval(uint32 epoch,bytes32 root,uint32 listVersion,uint40 validUntil,uint40 sourceCutoff,bytes32 snapshotId,address publisher)"
    );
    uint256 public constant MAX_EPOCH_AGE = EpochBounds.MAX_AGE;
    // Lifecycle events consumed by ProofmarkASC.

    /// @dev sig 0xffac883eea6676651044a7e28ee0527defa8e3fce7558142c598e6569ef5a5f3
    event MarkIssued(
        address indexed subject,
        bytes32 indexed attrs, // eight scalar fields packed by MarkAttrs
        address indexed issuer,
        bytes32 claimsRoot,
        bytes32 evidenceHash
    );

    /// @notice Versioned issuer-key provenance for stable contract issuers.
    /// @dev Legacy EOA issuers continue to use MarkIssued with implicit key epoch zero.
    event KeyedMarkIssued(
        address indexed subject,
        bytes32 indexed attrs,
        address indexed issuer,
        uint64 issuerKeyEpoch,
        bytes32 claimsRoot,
        bytes32 evidenceHash
    );

    /// @dev sig 0xdde75c52928e1a0e5b14011716a8309ab432e435d50ced197b667cc906d3fd09
    event MarkRevoked(address indexed subject, uint16 indexed reasonCode, uint32 indexed epoch);

    /// @dev sig 0x4e68a53405a08cc0e2bb7cd374ad540457f069bcf32e0830ea2e851815d6f5ae
    event SanctionDenied(address indexed subject, uint32 indexed listVersion, uint32 indexed epoch);

    /// @notice A governed correction and its exact replacement credential are emitted together.
    /// @dev The correction cannot make an old mark active: the following MarkIssued log is the
    ///      newly approved credential and the ASC consumes the whole receipt atomically.
    event SanctionDenialCorrected(
        address indexed subject,
        uint64 indexed denialRevision,
        uint256 indexed correctionId,
        bytes32 reasonHash,
        address proposer,
        address approver
    );

    /// @dev Epoch schema v2. publishedAt is set by this source contract, not the publisher.
    event RosterEpochPublished(
        uint32 indexed epoch,
        bytes32 indexed root,
        uint32 indexed listVersion,
        uint40 validUntil,
        uint40 sourceCutoff,
        uint40 publishedAt,
        bytes32 snapshotId
    );
    /// @notice Issuer actually authorized this exact root in the same publication transaction.
    event RosterIssuerAuthorized(uint32 indexed epoch, bytes32 indexed root, address indexed issuer);
    event RosterIssuerKeyAuthorized(
        uint32 indexed epoch, bytes32 indexed root, address indexed issuer, uint64 issuerKeyEpoch
    );
    /// @notice Source-authenticated boundary for one compromised stable-issuer key generation.
    event IssuerKeyCompromised(
        address indexed issuer, uint64 indexed issuerKeyEpoch, uint64 lastTrustedBlock, bytes32 reasonHash
    );

    struct RootApproval {
        address issuer;
        bytes signature;
    }

    // Operational events. Not read cross-chain; the ASC ignores them.
    event IssuerSet(address indexed account, bool allowed);
    event EpochPublisherSet(address indexed account, bool allowed);
    event DenialCorrectionApproverSet(address indexed account, bool allowed);
    event DenialCorrectionProposed(
        uint256 indexed correctionId,
        address indexed subject,
        uint64 indexed denialRevision,
        address proposer,
        bytes32 reasonHash,
        uint40 executeAfter
    );
    event DenialCorrectionApproved(uint256 indexed correctionId, address indexed approver, bytes32 indexed reasonHash);

    // State

    mapping(address => bool) public isIssuer;
    mapping(address => bool) public isEpochPublisher;
    mapping(address => bool) public isDenialCorrectionApprover;
    /// @notice Durable idempotency for public API-backed issuance. The request id is an opaque
    ///         flow digest; it contains no cleartext PII but remains wallet-linkable.
    mapping(bytes32 => bool) public processedRequest;

    /// @notice Last published epoch. The source enforces monotonicity as a first line of defence.
    uint32 public lastEpoch;

    struct DenialCorrection {
        address subject;
        address proposer;
        address approver;
        bytes32 attrs;
        bytes32 claimsRoot;
        bytes32 evidenceHash;
        bytes32 reasonHash;
        uint64 denialRevision;
        uint40 executeAfter;
        bool executed;
    }

    mapping(address => bool) public sourceDenialActive;
    mapping(address => uint64) public sourceDenialRevision;
    mapping(uint256 => DenialCorrection) public denialCorrections;
    uint256 public nextDenialCorrectionId = 1;

    error NotIssuer(address caller);
    error NotEpochPublisher(address caller);
    error LengthMismatch();
    error EpochNotMonotonic(uint32 given, uint32 last);
    error ZeroSubject();
    error RequestAlreadyProcessed(bytes32 requestId);
    error InvalidAttrs();
    error InvalidEpoch();
    error InvalidRootApprovals();
    error InvalidIssuerKeyProvenance();
    error InvalidCompromiseCutoff();
    error NotDenialCorrectionApprover(address caller);
    error InvalidDenialCorrection();
    error DenialCorrectionNotApproved(uint256 correctionId);
    error DenialCorrectionDelayActive(uint256 correctionId, uint40 executeAfter);

    modifier onlyIssuer() {
        if (!isIssuer[msg.sender]) revert NotIssuer(msg.sender);
        _;
    }

    modifier onlyEpochPublisher() {
        if (!isEpochPublisher[msg.sender]) revert NotEpochPublisher(msg.sender);
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) EIP712("ProofmarkRoster", "1") {}

    // Roles. Three separate keys: owner, issuer, epoch publisher.

    function setIssuer(address account, bool allowed) external onlyOwner {
        isIssuer[account] = allowed;
        emit IssuerSet(account, allowed);
    }

    function setEpochPublisher(address account, bool allowed) external onlyOwner {
        isEpochPublisher[account] = allowed;
        emit EpochPublisherSet(account, allowed);
    }

    /// @notice Assigns the independent approval side of denial correction. Issuers propose the
    ///         exact replacement credential; an address cannot approve its own proposal.
    function setDenialCorrectionApprover(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert InvalidDenialCorrection();
        isDenialCorrectionApprover[account] = allowed;
        emit DenialCorrectionApproverSet(account, allowed);
    }

    // Issuance, action 0

    struct Issuance {
        address subject;
        bytes32 attrs;
        bytes32 claimsRoot;
        bytes32 evidenceHash;
    }

    function issue(address subject, bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash) external onlyIssuer {
        if (subject == address(0)) revert ZeroSubject();
        if (!MarkAttrs.validAtIssuance(attrs, block.timestamp)) revert InvalidAttrs();
        emit MarkIssued(subject, attrs, msg.sender, claimsRoot, evidenceHash);
    }

    /// @notice Idempotent issuance for retryable APIs. Replaying a sealed browser flow cannot
    ///         spend issuer gas or create another source event after the first transaction lands.
    function issueOnce(bytes32 requestId, address subject, bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash)
        external
        onlyIssuer
    {
        if (subject == address(0)) revert ZeroSubject();
        if (processedRequest[requestId]) revert RequestAlreadyProcessed(requestId);
        if (!MarkAttrs.validAtIssuance(attrs, block.timestamp)) revert InvalidAttrs();
        processedRequest[requestId] = true;
        emit MarkIssued(subject, attrs, msg.sender, claimsRoot, evidenceHash);
    }

    /// @notice Idempotent issuance that authenticates the stable issuer's current operating-key generation.
    function issueOnceWithKey(
        bytes32 requestId,
        address subject,
        bytes32 attrs,
        bytes32 claimsRoot,
        bytes32 evidenceHash,
        uint64 issuerKeyEpoch
    ) external onlyIssuer {
        if (subject == address(0)) revert ZeroSubject();
        if (processedRequest[requestId]) revert RequestAlreadyProcessed(requestId);
        if (!MarkAttrs.validAtIssuance(attrs, block.timestamp)) revert InvalidAttrs();
        if (issuerKeyEpoch == 0 || _currentIssuerKeyEpoch(msg.sender) != issuerKeyEpoch) {
            revert InvalidIssuerKeyProvenance();
        }
        processedRequest[requestId] = true;
        emit KeyedMarkIssued(subject, attrs, msg.sender, issuerKeyEpoch, claimsRoot, evidenceHash);
    }

    /// @notice Records the recovery authority's approved last trusted source block for a key generation.
    /// @dev The caller is the stable issuer itself. The source authenticates that the declared generation
    ///      is current; the stable issuer retires it atomically in the same transaction.
    function declareIssuerKeyCompromise(uint64 issuerKeyEpoch, uint64 lastTrustedBlock, bytes32 reasonHash)
        external
        onlyIssuer
    {
        if (
            issuerKeyEpoch == 0 || _currentIssuerKeyEpoch(msg.sender) != issuerKeyEpoch || reasonHash == bytes32(0)
                || lastTrustedBlock >= block.number
        ) revert InvalidCompromiseCutoff();
        emit IssuerKeyCompromised(msg.sender, issuerKeyEpoch, lastTrustedBlock, reasonHash);
    }

    /// @notice Emit N issuances in one transaction; the ASC applies all of them in a single execute().
    /// @dev N marks per cross-chain round trip of about eight minutes. This is batching without
    function issueBatch(Issuance[] calldata items) external onlyIssuer {
        uint256 n = items.length;
        for (uint256 i = 0; i < n; ++i) {
            if (items[i].subject == address(0)) revert ZeroSubject();
            if (!MarkAttrs.validAtIssuance(items[i].attrs, block.timestamp)) revert InvalidAttrs();
            emit MarkIssued(items[i].subject, items[i].attrs, msg.sender, items[i].claimsRoot, items[i].evidenceHash);
        }
    }

    // Revocation, action 1

    function revoke(address subject, uint16 reasonCode, uint32 epoch) external onlyIssuer {
        if (subject == address(0)) revert ZeroSubject();
        emit MarkRevoked(subject, reasonCode, epoch);
    }

    /// @notice The event carries no data, which makes batch revocation cheap.
    function revokeBatch(address[] calldata subjects, uint16[] calldata reasonCodes, uint32 epoch) external onlyIssuer {
        uint256 n = subjects.length;
        if (n != reasonCodes.length) revert LengthMismatch();
        for (uint256 i = 0; i < n; ++i) {
            if (subjects[i] == address(0)) revert ZeroSubject();
            emit MarkRevoked(subjects[i], reasonCodes[i], epoch);
        }
    }

    // Sanction, action 2

    function deny(address subject, uint32 listVersion, uint32 epoch) external onlyIssuer {
        if (subject == address(0)) revert ZeroSubject();
        _recordDenial(subject);
        emit SanctionDenied(subject, listVersion, epoch);
    }

    function denyBatch(address[] calldata subjects, uint32 listVersion, uint32 epoch) external onlyIssuer {
        uint256 n = subjects.length;
        for (uint256 i = 0; i < n; ++i) {
            if (subjects[i] == address(0)) revert ZeroSubject();
            _recordDenial(subjects[i]);
            emit SanctionDenied(subjects[i], listVersion, epoch);
        }
    }

    function _recordDenial(address subject) private {
        sourceDenialActive[subject] = true;
        sourceDenialRevision[subject] += 1;
    }

    /// @notice Proposes both a correction of the current denial revision and the exact replacement
    ///         credential. The opaque reason hash commits to an off-chain case record without
    ///         putting legal conclusions or personal data on chain.
    function proposeDenialCorrection(
        address subject,
        bytes32 attrs,
        bytes32 claimsRoot,
        bytes32 evidenceHash,
        bytes32 reasonHash
    ) external onlyIssuer returns (uint256 correctionId) {
        if (
            subject == address(0) || !sourceDenialActive[subject] || reasonHash == bytes32(0)
                || !MarkAttrs.validAtIssuance(attrs, block.timestamp)
        ) revert InvalidDenialCorrection();
        correctionId = nextDenialCorrectionId++;
        uint40 executeAfter = uint40(block.timestamp + MIN_DENIAL_CORRECTION_DELAY);
        uint64 revision = sourceDenialRevision[subject];
        denialCorrections[correctionId] = DenialCorrection({
            subject: subject,
            proposer: msg.sender,
            approver: address(0),
            attrs: attrs,
            claimsRoot: claimsRoot,
            evidenceHash: evidenceHash,
            reasonHash: reasonHash,
            denialRevision: revision,
            executeAfter: executeAfter,
            executed: false
        });
        emit DenialCorrectionProposed(correctionId, subject, revision, msg.sender, reasonHash, executeAfter);
    }

    function approveDenialCorrection(uint256 correctionId) external {
        if (!isDenialCorrectionApprover[msg.sender]) revert NotDenialCorrectionApprover(msg.sender);
        DenialCorrection storage correction = denialCorrections[correctionId];
        if (
            correction.subject == address(0) || correction.executed || correction.approver != address(0)
                || correction.proposer == msg.sender || !sourceDenialActive[correction.subject]
                || sourceDenialRevision[correction.subject] != correction.denialRevision
        ) revert InvalidDenialCorrection();
        correction.approver = msg.sender;
        emit DenialCorrectionApproved(correctionId, msg.sender, correction.reasonHash);
    }

    /// @notice Permissionless execution after the delay. The stored proposal and independent
    ///         approval carry authority; the proposer must still be an enabled issuer.
    function executeDenialCorrection(uint256 correctionId) external {
        DenialCorrection storage correction = denialCorrections[correctionId];
        if (
            correction.subject == address(0) || correction.executed || !sourceDenialActive[correction.subject]
                || sourceDenialRevision[correction.subject] != correction.denialRevision
                || !isIssuer[correction.proposer] || !MarkAttrs.validAtIssuance(correction.attrs, block.timestamp)
        ) revert InvalidDenialCorrection();
        if (correction.approver == address(0)) revert DenialCorrectionNotApproved(correctionId);
        if (block.timestamp < correction.executeAfter) {
            revert DenialCorrectionDelayActive(correctionId, correction.executeAfter);
        }

        correction.executed = true;
        sourceDenialActive[correction.subject] = false;
        emit SanctionDenialCorrected(
            correction.subject,
            correction.denialRevision,
            correctionId,
            correction.reasonHash,
            correction.proposer,
            correction.approver
        );
        emit MarkIssued(
            correction.subject, correction.attrs, correction.proposer, correction.claimsRoot, correction.evidenceHash
        );
    }

    // Epoch publication, action 3

    /// @notice Publishes a bounded roster assertion. Requires epoch-schema v2 on source/ASC/Registry.
    /// @dev Fixes L1 writes independent of user count. The real driver for batching is Ethereum L1
    ///      gas, not the Creditcoin write cost, which measured 0.0002 CTC and is negligible.
    function publishEpoch(
        uint32 epoch,
        bytes32 root,
        uint32 listVersion,
        uint40 validUntil,
        uint40 sourceCutoff,
        bytes32 snapshotId
    ) external onlyEpochPublisher onlyIssuer {
        _checkEpoch(epoch, root, validUntil, sourceCutoff, snapshotId);
        // The source transaction itself authorizes only msg.sender's issuer identity.
        emit RosterIssuerAuthorized(epoch, root, msg.sender);
        _finishEpoch(epoch, root, listVersion, validUntil, sourceCutoff, snapshotId);
    }

    /// @notice A separate publisher must carry each issuer's exact-root EIP-712/1271 approval.
    function publishEpochForIssuers(
        uint32 epoch,
        bytes32 root,
        uint32 listVersion,
        uint40 validUntil,
        uint40 sourceCutoff,
        bytes32 snapshotId,
        RootApproval[] calldata approvals
    ) external onlyEpochPublisher {
        _checkEpoch(epoch, root, validUntil, sourceCutoff, snapshotId);
        if (approvals.length == 0 || approvals.length > MAX_ROSTER_ISSUERS) revert InvalidRootApprovals();
        bytes32 digest =
            rosterApprovalDigest(epoch, root, listVersion, validUntil, sourceCutoff, snapshotId, msg.sender);
        address previous;
        for (uint256 i; i < approvals.length; ++i) {
            RootApproval calldata approval = approvals[i];
            if (
                approval.issuer <= previous || !isIssuer[approval.issuer] || approval.signature.length > 4096
                    || !_validRootSignature(approval.issuer, digest, approval.signature)
            ) revert InvalidRootApprovals();
            previous = approval.issuer;
            emit RosterIssuerAuthorized(epoch, root, approval.issuer);
            uint64 issuerKeyEpoch = _currentIssuerKeyEpoch(approval.issuer);
            if (issuerKeyEpoch != 0) emit RosterIssuerKeyAuthorized(epoch, root, approval.issuer, issuerKeyEpoch);
        }
        _finishEpoch(epoch, root, listVersion, validUntil, sourceCutoff, snapshotId);
    }

    function rosterApprovalDigest(
        uint32 epoch,
        bytes32 root,
        uint32 listVersion,
        uint40 validUntil,
        uint40 sourceCutoff,
        bytes32 snapshotId,
        address publisher
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ROSTER_APPROVAL_TYPEHASH, epoch, root, listVersion, validUntil, sourceCutoff, snapshotId, publisher
                )
            )
        );
    }

    // Shanghai-compatible subset of EOA/ERC-1271 validation. OZ 5.4 SignatureChecker's
    // ERC-7913 dependency pulls Cancun MCOPY; do not change the target VM to hide that mismatch.
    function _validRootSignature(address issuer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (issuer.code.length == 0) {
            (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
            return error == ECDSA.RecoverError.NoError && signer == issuer;
        }
        (bool ok, bytes memory result) =
            issuer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
        return ok && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    /// @dev A zero result means the issuer uses the legacy EOA/contract path. A version-1 contract
    ///      must expose a nonzero uint64 epoch or fail closed instead of emitting false provenance.
    function _currentIssuerKeyEpoch(address issuer) private view returns (uint64) {
        if (issuer.code.length == 0) return 0;
        (bool versionOk, bytes memory versionData) = issuer.staticcall(abi.encodeWithSignature("ISSUER_KEY_VERSION()"));
        if (!versionOk || versionData.length < 32 || abi.decode(versionData, (uint256)) != 1) return 0;
        (bool epochOk, bytes memory epochData) = issuer.staticcall(abi.encodeWithSignature("keyEpoch()"));
        if (!epochOk || epochData.length < 32) revert InvalidIssuerKeyProvenance();
        uint256 epoch = abi.decode(epochData, (uint256));
        if (epoch == 0 || epoch > type(uint64).max) revert InvalidIssuerKeyProvenance();
        return uint64(epoch);
    }

    function _checkEpoch(uint32 epoch, bytes32 root, uint40 validUntil, uint40 sourceCutoff, bytes32 snapshotId)
        private
        view
    {
        if (epoch <= lastEpoch) revert EpochNotMonotonic(epoch, lastEpoch);
        if (
            block.timestamp > type(uint40).max
                || !EpochBounds.valid(root, sourceCutoff, uint40(block.timestamp), validUntil, snapshotId)
        ) revert InvalidEpoch();
    }

    function _finishEpoch(
        uint32 epoch,
        bytes32 root,
        uint32 listVersion,
        uint40 validUntil,
        uint40 sourceCutoff,
        bytes32 snapshotId
    ) private {
        lastEpoch = epoch;
        emit RosterEpochPublished(
            epoch, root, listVersion, validUntil, sourceCutoff, uint40(block.timestamp), snapshotId
        );
    }
}
