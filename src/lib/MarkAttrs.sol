// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title MarkAttrs
/// @notice Packs eight scalar mark fields into one bytes32. 192 bits used, 64 reserved.
/// @dev Schema 0 layout:
///  bit 255      248 247      240 239        224 223           208
///      │ kind  u8 │assurance u8│  regime u16  │ jurisdiction u16│
///  bit 207        176 175        136 135      96 95      64 63   0
///      │methods u32 │ issuedAt u40 │ expiry u40│ epoch u32│reserv│
///
/// Why pack: the whole encoded transaction travels as calldata, so a smaller log costs less
/// gas to verify. Keeping attrs indexed lets the ASC read it straight from topics with no
/// abi.decode. Schema 0 requires all reserved bits to be zero; extension requires a new decoder.
library MarkAttrs {
    // Schema 0 is the original eight-field layout. All 64 reserved bits MUST remain zero.
    // A future version needs an explicit decoder/migration, not silent bit truncation.
    uint256 internal constant SCHEMA_VERSION = 0;
    uint32 internal constant SUPPORTED_METHODS = 0x001f07ff;

    function validSchema(bytes32 a) internal pure returns (bool) {
        return uint64(uint256(a)) == 0 && (kind(a) == 1 || kind(a) == 2) && assurance(a) >= 1 && assurance(a) <= 5
            && (regime(a) == 1 || regime(a) == 2) && jurisdiction(a) >= 1 && jurisdiction(a) <= 999
            && (methods(a) & ~SUPPORTED_METHODS) == 0 && issuedAt(a) != 0 && expiry(a) > issuedAt(a);
    }

    function validAtIssuance(bytes32 a, uint256 now_) internal pure returns (bool) {
        return validSchema(a) && issuedAt(a) <= now_ && expiry(a) > now_;
    }

    function pack(
        uint8 kind_,
        uint8 assurance_,
        uint16 regime_,
        uint16 jurisdiction_,
        uint32 methods_,
        uint40 issuedAt_,
        uint40 expiry_,
        uint32 epoch_
    ) internal pure returns (bytes32) {
        // Accumulate step by step. Combining eight arguments in one expression hits stack too deep.
        uint256 v;
        v |= uint256(kind_) << 248;
        v |= uint256(assurance_) << 240;
        v |= uint256(regime_) << 224;
        v |= uint256(jurisdiction_) << 208;
        v |= uint256(methods_) << 176;
        v |= uint256(issuedAt_) << 136;
        v |= uint256(expiry_) << 96;
        v |= uint256(epoch_) << 64;
        return bytes32(v);
    }

    function kind(bytes32 a) internal pure returns (uint8) {
        return uint8(uint256(a) >> 248);
    }

    function assurance(bytes32 a) internal pure returns (uint8) {
        return uint8(uint256(a) >> 240);
    }

    function regime(bytes32 a) internal pure returns (uint16) {
        return uint16(uint256(a) >> 224);
    }

    function jurisdiction(bytes32 a) internal pure returns (uint16) {
        return uint16(uint256(a) >> 208);
    }

    function methods(bytes32 a) internal pure returns (uint32) {
        return uint32(uint256(a) >> 176);
    }

    function issuedAt(bytes32 a) internal pure returns (uint40) {
        return uint40(uint256(a) >> 136);
    }

    function expiry(bytes32 a) internal pure returns (uint40) {
        return uint40(uint256(a) >> 96);
    }

    function epoch(bytes32 a) internal pure returns (uint32) {
        return uint32(uint256(a) >> 64);
    }
}
