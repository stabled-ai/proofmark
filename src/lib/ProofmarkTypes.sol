// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice ASC action codes. First argument to `execute(action, ...)`.
enum Action {
    MarkIssued, // 0
    MarkRevoked, // 1
    SanctionDenied, // 2
    RosterEpoch, // 3
    IssuerKeyCompromise, // 4
    SanctionDenialCorrection // 5
}

/// @notice Mark status
enum MarkStatus {
    None, // 0 never issued
    Active, // 1
    Revoked, // 2
    Denied, // 3 sanctioned
    Suspended // 4
}

/// @notice Bitmap of checks performed. Carries what was done, not a verdict.
/// @dev Recording facts instead of a shared verdict makes the mark portable across regimes.
library Methods {
    // Identity checks
    uint32 internal constant WALLET_CONTROL = 1 << 0;
    uint32 internal constant ID_DOC_IMAGE = 1 << 1;
    uint32 internal constant ID_DOC_AUTHENTICITY = 1 << 2;
    uint32 internal constant FACE_MATCH = 1 << 3;
    uint32 internal constant LIVENESS = 1 << 4;
    uint32 internal constant BANK_ACCOUNT = 1 << 5;
    uint32 internal constant MOBILE_CARRIER = 1 << 6;
    uint32 internal constant VIDEO_CALL = 1 << 7;
    uint32 internal constant IN_PERSON = 1 << 8;
    uint32 internal constant EPASSPORT_NFC = 1 << 9;
    uint32 internal constant GOV_EID = 1 << 10;
    // Screening checks
    uint32 internal constant SANCTIONS_SCREENED = 1 << 16;
    uint32 internal constant PEP_SCREENED = 1 << 17;
    uint32 internal constant ADVERSE_MEDIA = 1 << 18;
    uint32 internal constant JURISDICTION_CHECK = 1 << 19;
    // Not earned by an exact listed-wallet lookup. Current built-in engine leaves this unset.
    uint32 internal constant ONCHAIN_EXPOSURE = 1 << 20;
}

/// @notice Revocation reason codes emitted by ComplianceSource.
library RevokeReason {
    uint16 internal constant USER_REQUEST = 1;
    uint16 internal constant RESCREEN_HIT = 2;
    uint16 internal constant DOC_EXPIRED = 3;
    uint16 internal constant ISSUER_ERROR = 4;
    uint16 internal constant RISK_ESCALATED = 5;
    uint16 internal constant APPEAL_UPHELD = 6;
}

/// @notice How the mark reached this chain.
/// @dev The ASC sets this from the action it processed. The source event does not carry it.
///      Packing it into attrs would let an issuer claim Roster provenance it never earned.
///      Provenance is something the protocol observes, not something the issuer declares.
enum MarkOrigin {
    None, // 0 never issued
    Direct, // 1 individual proof (Mode A): issued at L1 block N, a proven past fact
    Roster // 2 epoch roster (Mode B): the full valid set at that epoch
}

/// @notice The on-chain mark. No cleartext PII; wallet-linked metadata and commitments remain
///         pseudonymous data and should not be described as anonymous.
struct Mark {
    uint8 status;
    uint8 origin; // MarkOrigin, set by the ASC. The source cannot claim it.
    uint8 kind; // Positive schema-0 credentials: 1 INDIVIDUAL · 2 ENTITY. Denial is a separate event.
    uint8 assurance; // issuer's own grade, 1..5. Not a claim of equivalence to any regime.
    uint16 regime;
    uint16 jurisdiction; // ISO-3166 numeric
    uint32 methods;
    uint40 issuedAt;
    uint40 expiry;
    uint32 epoch;
    bytes32 claimsRoot;
    bytes32 evidenceHash;
    address issuer;
}

/// @notice Pass conditions a consumer dApp registers.
/// @dev `requireRoster` carries the weight here. A Direct mark is a weaker guarantee than a
///      Roster mark, and the policy surfaces that difference instead of hiding it in code.
///
///      Direct: proof that the mark was issued. Says nothing about a revocation that was never
///              submitted cross-chain.
///      Roster: the publisher's asserted set at an epoch; absence does not establish its reason.
///      Credential kind is bound separately by Registry.policyKind and cannot change on update.
struct Policy {
    uint32 requireAll; // every bit here must be present
    uint8 minAssurance;
    uint40 maxAge; // freshness ceiling, 0 means unbounded
    uint16 requiredRegime; // 0 accepts any regime; production policies pin this
    uint16 requiredJurisdiction; // ISO-3166 numeric; 0 accepts any jurisdiction
    address trustedIssuer; // address(0) accepts any issuer
    bool requireRoster; // accept roster-backed marks only
    bool exists;
}
