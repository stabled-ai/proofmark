// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Mark, Policy, MarkStatus, MarkOrigin} from "./lib/ProofmarkTypes.sol";
import {RosterProof} from "./lib/RosterProof.sol";
import {MarkAttrs} from "./lib/MarkAttrs.sol";

interface IProofmarkASC {
    function ATTRS_SCHEMA_VERSION() external view returns (uint256);
    function TRANSACTION_PROCESSING_VERSION() external view returns (uint256);
    function EPOCH_SCHEMA_VERSION() external view returns (uint256);
    function ROSTER_AUTH_VERSION() external view returns (uint256);
    function ISSUER_KEY_PROVENANCE_VERSION() external view returns (uint256);
    function epochIssuerApproved(uint32 epoch, address issuer) external view returns (bool);
    function isEpochIssuerUsable(uint32 epoch, address issuer) external view returns (bool);
    function isMarkIssuerUsable(address subject) external view returns (bool);
    function isRosterFresh() external view returns (bool);
    function getMark(address subject) external view returns (Mark memory);
    function tombstone(address subject) external view returns (bool);
    function latestEpoch() external view returns (uint32);
    function epochValidUntil() external view returns (uint40);
    function epochRoots(uint32 epoch) external view returns (bytes32);
}

/// @notice Raw mark fields as carried in the epoch roster. Only what root comparison needs.
struct RosterMark {
    bytes32 attrs;
    bytes32 claimsRoot;
    bytes32 evidenceHash;
    address issuer;
}

/// @title ProofmarkRegistry
/// @notice The only surface a dApp calls. One line: `isVerified(subject, policyId)`.
///
/// Policy registration is permissionless. Each dApp registers what its own jurisdiction and risk
/// appetite require. We make no equivalence claim between Korean and EU KYC. We publish the checks
/// that were performed; the consumer decides whether they satisfy its policy.
contract ProofmarkRegistry {
    uint256 public constant ROSTER_FORMAT_VERSION = 2;
    uint256 public constant ATTRS_SCHEMA_VERSION = 0;
    uint256 public constant POLICY_SCHEMA_VERSION = 2;
    uint256 public constant EPOCH_SCHEMA_VERSION = 2;
    uint256 public constant ROSTER_AUTH_VERSION = 1;
    uint256 public constant ROSTER_WITNESS_VERSION = 1;
    uint256 public constant ISSUER_KEY_PROVENANCE_VERSION = 1;
    IProofmarkASC public immutable ASC;

    mapping(uint256 => Policy) public policies;
    mapping(uint256 => address) public policyOwner;
    mapping(uint256 => bool) public policyFrozen;
    /// @notice Immutable credential kind for this policy: 1 individual, 2 entity. No wildcard.
    mapping(uint256 => uint8) public policyKind;
    uint256 public nextPolicyId = 1;

    struct RosterWitness {
        uint32 epoch;
        RosterMark mark;
    }
    mapping(address => RosterWitness) private rosterWitnesses;
    event RosterWitnessCached(address indexed subject, uint32 indexed epoch, bytes32 indexed root);
    error InvalidRosterWitness();

    event PolicyRegistered(uint256 indexed policyId, address indexed owner);
    event PolicyUpdated(uint256 indexed policyId);
    event PolicyOwnerTransferred(uint256 indexed policyId, address indexed newOwner);
    event PolicyFrozen(uint256 indexed policyId);
    event PolicyKindBound(uint256 indexed policyId, uint8 kind);

    error UnknownPolicy(uint256 policyId);
    error NotPolicyOwner(uint256 policyId, address caller);
    error FrozenPolicy(uint256 policyId);
    error NotImplementedYet();
    error InvalidPolicy();

    constructor(address asc) {
        require(asc != address(0), "zero asc");
        ASC = IProofmarkASC(asc);
        require(ASC.ATTRS_SCHEMA_VERSION() == 0 && ASC.TRANSACTION_PROCESSING_VERSION() == 2, "unsupported ASC schema");
        require(ASC.EPOCH_SCHEMA_VERSION() == 2, "unsupported epoch schema");
        require(ASC.ROSTER_AUTH_VERSION() == 1, "unsupported roster authorization");
        require(ASC.ISSUER_KEY_PROVENANCE_VERSION() == 1, "unsupported issuer key provenance");
    }

    // Policy registration, permissionless

    function registerPolicy(Policy calldata p) external returns (uint256 policyId) {
        return _registerPolicy(p, 1); // Legacy ABI is explicitly individual-only, never any-kind.
    }

    function registerPolicyForKind(Policy calldata p, uint8 kind) external returns (uint256 policyId) {
        return _registerPolicy(p, kind);
    }

    function _registerPolicy(Policy calldata p, uint8 kind) private returns (uint256 policyId) {
        if (kind != 1 && kind != 2) revert InvalidPolicy();
        _validatePolicy(p);
        policyId = nextPolicyId++;
        Policy memory stored = p;
        stored.exists = true;
        policies[policyId] = stored;
        policyOwner[policyId] = msg.sender;
        policyKind[policyId] = kind;
        emit PolicyRegistered(policyId, msg.sender);
        emit PolicyKindBound(policyId, kind);
    }

    function updatePolicy(uint256 policyId, Policy calldata p) external {
        if (!policies[policyId].exists) revert UnknownPolicy(policyId);
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner(policyId, msg.sender);
        if (policyFrozen[policyId]) revert FrozenPolicy(policyId);
        _validatePolicy(p);
        Policy memory stored = p;
        stored.exists = true;
        policies[policyId] = stored;
        emit PolicyUpdated(policyId);
    }

    function _validatePolicy(Policy calldata p) private pure {
        if (
            (p.requireAll & ~MarkAttrs.SUPPORTED_METHODS) != 0 || p.minAssurance > 5 || p.requiredRegime > 2
                || p.requiredJurisdiction > 999
        ) revert InvalidPolicy();
    }

    function transferPolicyOwner(uint256 policyId, address newOwner) external {
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner(policyId, msg.sender);
        require(newOwner != address(0), "zero owner");
        policyOwner[policyId] = newOwner;
        emit PolicyOwnerTransferred(policyId, newOwner);
    }

    /// @notice Permanently freezes a policy. A gated asset can then bind to immutable policy
    ///         content, not merely an immutable numeric id.
    function freezePolicy(uint256 policyId) external {
        if (!policies[policyId].exists) revert UnknownPolicy(policyId);
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner(policyId, msg.sender);
        policyFrozen[policyId] = true;
        emit PolicyFrozen(policyId);
    }

    // Decision

    function policyRequiresRoster(uint256 policyId) external view returns (bool) {
        return policies[policyId].exists && policies[policyId].requireRoster;
    }

    function getRosterWitness(address subject) external view returns (uint32 epoch, RosterMark memory mark) {
        RosterWitness storage w = rosterWitnesses[subject];
        return (w.epoch, w.mark);
    }

    /// @notice Permissionless proof delivery for storage-only consumers. Never rewrites the ASC
    ///         Direct mark, its source cursor or its denial state. Cache time grants no new lifetime.
    function cacheRosterWitness(address subject, RosterMark calldata mark, RosterProof.Inclusion calldata inclusion)
        external
    {
        if (!_rosterContains(subject, mark, inclusion)) revert InvalidRosterWitness();
        uint32 epoch = ASC.latestEpoch();
        rosterWitnesses[subject] = RosterWitness(epoch, mark);
        emit RosterWitnessCached(subject, epoch, ASC.epochRoots(epoch));
    }

    /// @notice Storage mode: required-roster policies use a current verified witness; other
    ///         policies use ASC materialized state with the explicitly weaker Direct semantics.
    /// @dev Fail closed. Unknown is a rejection, not a pass.
    function isVerified(address subject, uint256 policyId) public view returns (bool) {
        Policy memory p = policies[policyId];
        if (!p.exists) return false; // an unregistered policy never passes

        if (ASC.tombstone(subject)) return false; // 1. deny beats allow, always

        if (p.requireRoster) {
            RosterWitness storage w = rosterWitnesses[subject];
            if (w.epoch == 0 || w.epoch != ASC.latestEpoch() || !ASC.isRosterFresh()) return false;
            if (!ASC.isEpochIssuerUsable(w.epoch, w.mark.issuer)) return false;
            return _policyHolds(w.mark.attrs, w.mark.issuer, p, policyKind[policyId]);
        }

        Mark memory m = ASC.getMark(subject);
        if (m.status != uint8(MarkStatus.Active)) return false;
        if (!ASC.isMarkIssuerUsable(subject)) return false;

        bytes32 attrs =
            MarkAttrs.pack(m.kind, m.assurance, m.regime, m.jurisdiction, m.methods, m.issuedAt, m.expiry, m.epoch);
        if (!_policyHolds(attrs, m.issuer, p, policyKind[policyId])) return false;

        // 7. freshness by provenance
        return _fresh(m, p);
    }

    /// @notice Freshness depends on where the mark came from.
    /// @dev A Direct mark belongs to no epoch, so enforcing `epoch == latestEpoch` would fail every
    ///      Mode A mark. The policy decides instead, through requireRoster.
    ///
    ///      Direct: proof the mark was issued at L1 block N. It does not go stale when we stop
    ///              publishing, but it also cannot see a revocation that was never submitted.
    ///      Roster: the publisher's asserted set at an epoch; absence alone does not establish why.
    function _fresh(Mark memory m, Policy memory p) internal view returns (bool) {
        if (m.origin == uint8(MarkOrigin.Roster)) {
            if (m.epoch != ASC.latestEpoch()) return false; // a stale cache is not a truth
            if (!ASC.isEpochIssuerUsable(m.epoch, m.issuer)) return false;
            return ASC.isRosterFresh();
        }
        // Direct
        return m.origin == uint8(MarkOrigin.Direct) && !p.requireRoster;
    }

    /// @notice Several subjects at once, for frontend convenience.
    function areVerified(address[] calldata subjects, uint256 policyId) external view returns (bool[] memory out) {
        out = new bool[](subjects.length);
        for (uint256 i = 0; i < subjects.length; ++i) {
            out[i] = isVerified(subjects[i], policyId);
        }
    }

    /// @notice Sanction status on its own.
    function isDenied(address subject) external view returns (bool) {
        return ASC.tombstone(subject) && ASC.getMark(subject).status == uint8(MarkStatus.Denied);
    }

    // ─────────────────────── P1 ───────────────────────

    // Proof mode, Mode B

    /// @dev CAIP-10 style namespace, leaving room for non-EVM subjects.
    string public constant NAMESPACE = "eip155";

    /**
     * @notice Proof mode. Verifies directly against an epoch roster root, writing no state.
     *
     * How it differs from cache mode (`isVerified`):
     *   cache: reads state the ASC materialised. Cheap, but the provenance is an individual proof.
     *   proof: membership in the publisher's asserted set at that epoch. Completeness remains a trust assumption.
     *
     * Roster membership is itself the freshness argument, so this path is Roster by definition.
     * A storage-only consumer can use the same proof via cacheRosterWitness + isVerified.
     */
    function verifyWithRoster(
        address subject,
        uint256 policyId,
        RosterMark calldata mark,
        RosterProof.Inclusion calldata inclusion
    ) external view returns (bool) {
        Policy memory p = policies[policyId];
        if (!p.exists) return false;
        return
            _rosterContains(subject, mark, inclusion) && _policyHolds(mark.attrs, mark.issuer, p, policyKind[policyId]);
    }

    function _rosterContains(address subject, RosterMark calldata mark, RosterProof.Inclusion calldata inclusion)
        private
        view
        returns (bool)
    {
        if (subject == address(0)) return false;

        // 1. tombstones outrank the roster, so an urgent revocation need not wait for the next epoch
        if (ASC.tombstone(subject)) return false;

        // 2. roster freshness. Once expired nobody verifies; unknown is never a pass.
        if (!ASC.isRosterFresh()) return false;

        if (!ASC.isEpochIssuerUsable(ASC.latestEpoch(), mark.issuer)) return false;

        // 3. is this mark carried in the current epoch root
        bytes32 root = ASC.epochRoots(ASC.latestEpoch());
        if (root == bytes32(0)) return false;

        bytes32 leaf = RosterProof.leafOf(
            RosterProof.subjectKey(NAMESPACE, subject),
            RosterProof.markHash(mark.attrs, mark.claimsRoot, mark.evidenceHash, mark.issuer)
        );
        return RosterProof.verifyInclusion(root, leaf, inclusion);
    }

    /**
     * @notice Proves absence from the current, unexpired roster, not the reason for that absence.
     * @dev Membership is easy; non-membership is decided by the data structure. Sorted-key tree
     */
    function proveNotInRoster(address subject, RosterProof.NonInclusion calldata proof) external view returns (bool) {
        if (!ASC.isRosterFresh()) return false;
        bytes32 root = ASC.epochRoots(ASC.latestEpoch());
        if (root == bytes32(0)) return false;
        return RosterProof.verifyNonInclusion(root, RosterProof.subjectKey(NAMESPACE, subject), proof);
    }

    /// @dev Applies the policy straight from packed `attrs`, same layout as MarkAttrs.sol.
    function _policyHolds(bytes32 attrs, address issuer, Policy memory p, uint8 kind) private view returns (bool) {
        if (!MarkAttrs.validSchema(attrs) || MarkAttrs.kind(attrs) != kind || issuer == address(0)) return false;
        uint256 v = uint256(attrs);
        uint8 assurance = uint8(v >> 240);
        uint16 regime = uint16(v >> 224);
        uint16 jurisdiction = uint16(v >> 208);
        uint32 methods = uint32(v >> 176);
        uint40 issuedAt = uint40(v >> 136);
        uint40 expiry = uint40(v >> 96);

        if ((methods & p.requireAll) != p.requireAll) return false;
        if (assurance < p.minAssurance) return false;
        if (p.requiredRegime != 0 && regime != p.requiredRegime) return false;
        if (p.requiredJurisdiction != 0 && jurisdiction != p.requiredJurisdiction) return false;
        if (p.trustedIssuer != address(0) && issuer != p.trustedIssuer) return false;
        if (expiry <= block.timestamp) return false;
        if (issuedAt > block.timestamp || expiry <= issuedAt) return false;
        if (p.maxAge != 0) {
            if (block.timestamp - issuedAt > p.maxAge) return false;
        }
        return true; // roster provenance, so requireRoster is satisfied by construction
    }
}
