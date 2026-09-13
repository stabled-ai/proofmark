#!/usr/bin/env bash
#
# Proofmark demo video — STRICT v2 checks for the post-migration deployment. Not the recording kit.
# The two-minute recording kit against the live deployment is commands.sh (same directory).
#
# Blocks retain the older verification scene numbers, not the new two-minute SHOTLIST numbers.
# Run the strict read-only checks with reviewed deployment pins:
#
#   bash docs/demo-video/commands-v2.sh
#
# Run one scene's block on camera:
#
#   SCENES=6 bash docs/demo-video/commands-v2.sh
#   SCENES="6 7 8" bash docs/demo-video/commands-v2.sh
#
# Two modes:
#
#   default (RECORD unset)  read-only. No transaction is sent, no chain state changes, no secret is
#                           read. Reviewed issuer/runtime settings are required for chain scenes.
#                           Runtime/state calls use one height per chain with a final hash fence.
#                           Historical "# ->" comments are not current verification results.
#   RECORD=1                adds the record-time blocks: the two live GatedRwaNote transfers in
#                           scene 7, and the take-B verdict in scene 6 for the mark that only exists
#                           once the human has pre-issued it. These need exported variables; each
#                           one says which.
#
# Two cast gotchas, repeated as comments next to the commands they bite:
#   * pass --from on a gated call, or msg.sender is zero and onlyOwner fires before the gate
#   * "missing field mixHash" from cast on CC3 is harmless; Creditcoin runs a Substrate block format
#
# Historical outputs captured on 2026-09-01 remain as context, not current evidence.
# As of 2026-09-07 the checks require reviewed runtime/issuer pins and compatible v2 contracts.
# A legacy or incorrectly pinned deployment must fail before any scene claim is accepted.

set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
assert_output() { node "$repo_dir/script/assert-demo-output.mjs" "$@"; }
assert_call() {
  local label="$1" expected="$2"; shift 2
  cast call "$@" | assert_output scalar "$label" "$expected"
}

# --- what the video points at -------------------------------------------------------------------

CC3="${CC3:-https://rpc.cc3-testnet.creditcoin.network}"        # chainId 102031
SEP="${SEP:-https://ethereum-sepolia-rpc.publicnode.com}"       # chainId 11155111
DEMO_URL="${DEMO_URL:-https://attest-kyc.stabled.ai}"           # the hosted demo, a project domain
SEPOLIA_EXPLORER="https://sepolia.etherscan.io"
CC3_EXPLORER="https://creditcoin-testnet.blockscout.com"

ASC=0x8c29A966a30d9083B760451245aECEbBE1E2d2F4   # ProofmarkASC, CC3
REG=0x5752897b1edaD4fe50908B38c4ddA5f376a43110   # ProofmarkRegistry, CC3
NOTE=0x5C16b3A87fa909b8BDb899476D049a85A56380B5  # GatedRwaNote "KR Pilot Credit Note" / KPCN, POLICY_ID 2
SRC=0xfb46D722CD70F1ed399616a9B4745E60B9220609   # ComplianceSource, Sepolia

SUB=0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2        # sandbox mark: methods 0x190027, assurance 3

# Scene 7 cast. All three were established on chain by the gate run recorded in README section 4.
RWA_HOLDER="${RWA_HOLDER:-0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2}"     # A, holds 60 KPCN, passes policy 2
RWA_RECIPIENT="${RWA_RECIPIENT:-0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee}" # B, passes policy 2
RWA_CONTROL="${RWA_CONTROL:-0x00000000000000000000000000000000DeaDBeef}" # never issued, passes nothing

# Set at record time only: the subject of a mark pre-issued through /verify after its attestation
# has crossed to CC3. Confirm the mark with the read-only verifier before recording scene 6.
TAKE_B_SUBJECT="${TAKE_B_SUBJECT:-}"

# Optional: the Sepolia tx hash the /verify issuance returned, so scene 4 can print its explorer URL.
SEPOLIA_TX="${SEPOLIA_TX:-}"

ONE=1000000000000000000   # 1 KPCN, 18 decimals

MARK_TUPLE='getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))'

SCENES="${SCENES:-all}"
RECORD="${RECORD:-0}"
case "$RECORD" in 0|1) ;; *) echo 'FAIL: RECORD must be 0 or 1' >&2; exit 1 ;; esac
for scene in $SCENES; do
  case "$scene" in all|2|3|4|6|7|8) ;; *) echo 'FAIL: unknown scene' >&2; exit 1 ;; esac
done
[ -n "$SCENES" ] || { echo 'FAIL: no scenes selected' >&2; exit 1; }
CC3_BLOCK=''; CC3_BLOCK_HASH=''; SEP_BLOCK=''; SEP_BLOCK_HASH=''
ISSUANCE_BLOCK=''; ISSUANCE_BLOCK_HASH=''

want() { case " $SCENES " in *" all "*) return 0 ;; *" $1 "*) return 0 ;; *) return 1 ;; esac; }
banner() { printf '\n=== scene %s — %s\n' "$1" "$2"; }

# Every chain scene must establish these expectations even when scene 6 is not selected.
# Hashes and issuer are non-secret, independently reviewed deployment pins, never learned from RPC.
if want 4 || want 6 || want 7 || want 8; then
  : "${DEMO_EXPECTED_ISSUER:?provide the reviewed policy issuer address (not a private key)}"
  : "${DEMO_ASC_CODEHASH:?provide reviewed ASC runtime keccak256}"
  : "${DEMO_SOURCE_CODEHASH:?provide reviewed source runtime keccak256}"
  : "${DEMO_REGISTRY_CODEHASH:?provide reviewed Registry runtime keccak256}"
  : "${DEMO_NOTE_CODEHASH:?provide reviewed note runtime keccak256}"
  cast chain-id --rpc-url "$CC3" | assert_output scalar 'CC3 chain ID' 102031
  cast chain-id --rpc-url "$SEP" | assert_output scalar 'source chain ID' 11155111
  if [ "$RECORD" = 0 ]; then
    # One height per chain for ALL runtime, policy, mark, balance and simulated-transfer reads.
    # The final canonical-hash fence below must pass before the overall success message.
    [ "$CC3" != "$SEP" ] || { echo 'FAIL: source and hub RPC scopes must differ' >&2; exit 1; }
    hub_pin="$(command cast block latest --json --rpc-url "$CC3" | node "$repo_dir/script/demo-block.mjs" pin)"
    source_pin="$(command cast block latest --json --rpc-url "$SEP" | node "$repo_dir/script/demo-block.mjs" pin)"
    read -r CC3_BLOCK CC3_BLOCK_HASH <<< "$hub_pin"
    read -r SEP_BLOCK SEP_BLOCK_HASH <<< "$source_pin"
    printf 'read-only anchors: hub=%s %s source=%s %s\n' "$CC3_BLOCK" "$CC3_BLOCK_HASH" "$SEP_BLOCK" "$SEP_BLOCK_HASH"
    cast() {
      local operation="$1" arg rpc='' expecting_rpc=0 selected_block=''
      if [ "$operation" = call ] || [ "$operation" = code ]; then
        for arg in "$@"; do
          if [ "$expecting_rpc" = 1 ]; then rpc="$arg"; expecting_rpc=0; continue; fi
          case "$arg" in
            --rpc-url) [ -z "$rpc" ] || { echo 'FAIL: duplicate RPC scope' >&2; return 1; }; expecting_rpc=1 ;;
            --block|-b|-B|--block=*) echo 'FAIL: scene cannot override its block anchor' >&2; return 1 ;;
          esac
        done
        [ "$expecting_rpc" = 0 ] || { echo 'FAIL: missing RPC scope' >&2; return 1; }
        if [ "$rpc" = "$CC3" ]; then selected_block="$CC3_BLOCK"
        elif [ "$rpc" = "$SEP" ]; then selected_block="$SEP_BLOCK"
        else echo 'FAIL: unpinned RPC scope' >&2; return 1; fi
        command cast "$@" --block "$selected_block"
      else command cast "$@"; fi
    }
  fi
  cast code "$ASC" --rpc-url "$CC3" | assert_output runtime 'ASC runtime pin' "$DEMO_ASC_CODEHASH"
  cast code "$SRC" --rpc-url "$SEP" | assert_output runtime 'source runtime pin' "$DEMO_SOURCE_CODEHASH"
  cast code "$REG" --rpc-url "$CC3" | assert_output runtime 'Registry runtime pin' "$DEMO_REGISTRY_CODEHASH"
  cast code "$NOTE" --rpc-url "$CC3" | assert_output runtime 'note runtime pin' "$DEMO_NOTE_CODEHASH"
  assert_call 'atomic receipt version' 2 "$ASC" 'TRANSACTION_PROCESSING_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'ASC epoch schema' 2 "$ASC" 'EPOCH_SCHEMA_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'ASC issuer authorization' 1 "$ASC" 'ROSTER_AUTH_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'ASC attribute schema' 0 "$ASC" 'ATTRS_SCHEMA_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'source epoch schema' 2 "$SRC" 'EPOCH_SCHEMA_VERSION()(uint256)' --rpc-url "$SEP"
  assert_call 'source issuer authorization' 1 "$SRC" 'ROSTER_AUTH_VERSION()(uint256)' --rpc-url "$SEP"
  assert_call 'source attribute schema' 0 "$SRC" 'ATTRS_SCHEMA_VERSION()(uint256)' --rpc-url "$SEP"
  assert_call 'expected issuer is authorized' true "$SRC" 'isIssuer(address)(bool)' "$DEMO_EXPECTED_ISSUER" --rpc-url "$SEP"
  assert_call 'roster format' 2 "$REG" 'ROSTER_FORMAT_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'policy schema' 2 "$REG" 'POLICY_SCHEMA_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'epoch schema' 2 "$REG" 'EPOCH_SCHEMA_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'issuer authorization' 1 "$REG" 'ROSTER_AUTH_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'roster witness' 1 "$REG" 'ROSTER_WITNESS_VERSION()(uint256)' --rpc-url "$CC3"
  assert_call 'source chain key' 1 "$ASC" 'expectedChainKey()(uint64)' --rpc-url "$CC3"
  assert_call 'source contract' "$SRC" "$ASC" 'sourceContract()(address)' --rpc-url "$CC3"
  assert_call 'Registry ASC' "$ASC" "$REG" 'ASC()(address)' --rpc-url "$CC3"
  assert_call 'note Registry' "$REG" "$NOTE" 'REGISTRY()(address)' --rpc-url "$CC3"
  assert_call 'note policy' 2 "$NOTE" 'POLICY_ID()(uint256)' --rpc-url "$CC3"
  for policy in 1 2; do
    assert_call "policy $policy frozen" true "$REG" 'policyFrozen(uint256)(bool)' "$policy" --rpc-url "$CC3"
    assert_call "policy $policy individual kind" 1 "$REG" 'policyKind(uint256)(uint8)' "$policy" --rpc-url "$CC3"
  done
  cast call "$REG" 'policies(uint256)(uint32,uint8,uint40,uint16,uint16,address,bool,bool)' 1 --rpc-url "$CC3" \
    | assert_output tuple 'production policy fields' 65572 2 2592000 1 410 "$DEMO_EXPECTED_ISSUER" true true
  cast call "$REG" 'policies(uint256)(uint32,uint8,uint40,uint16,uint16,address,bool,bool)' 2 --rpc-url "$CC3" \
    | assert_output tuple 'pilot policy fields' 65572 2 604800 2 410 "$DEMO_EXPECTED_ISSUER" true true
fi

# --- scene 2 — live sanctions screening ---------------------------------------------------------
# On camera this runs in the browser at $DEMO_URL/ (the page ships this exact preset). The terminal
# form is the same request, kept here so the claim can be checked without a browser.

if want 2; then
  banner 2 "live sanctions screening"
  curl -fsS --max-time 30 -X POST "$DEMO_URL/api/screen" \
    -H 'content-type: application/json' \
    -d '{"fullName":"Kim Jong Un","dateOfBirth":"1984-01-08","nationality":"KP"}' \
    | assert_output screen 'screening decision and matched entry'
  # -> "decision":"BLOCK"
  # -> "riskBand":5
  # -> "listId":"OFAC_SDN"   "entryId":"20157"   "corroborated":true
fi

# --- scene 3 — what this deployment is configured to run ----------------------------------------
# The disclosure the narration is required to speak: the id and bank vendors are labelled demo
# adapters, and the screening axis is real.

if want 3; then
  banner 3 "vendor configuration of the hosted deployment"
  status_json="$(curl -fsS --max-time 30 "$DEMO_URL/api/kyc/status")"
  printf '%s' "$status_json" | assert_output status 'configured sandbox and recovery journal' "$SRC"
  printf '%s\n' "$status_json" | tr ',' '\n' | grep -E '"demo"|"sandboxBits"|"vendor"|"live"|"configured"|"address"'
  # -> "demo":true          the deployment runs the labelled demo tier
  # -> "sandboxBits":true   so the mark carries regime KR_FSC_NONFACE_SANDBOX
  # -> "vendor":"demo:id"   "vendor":"demo:bank"   "live":false
  # -> "configured":true    for id, bank and issuer
  # -> "address":"0xfb46D722CD70F1ed399616a9B4745E60B9220609"
  #      NB this is ComplianceSource on Sepolia, the contract the issuer writes to — not the signing
  #      EOA. The signer appears as onchain.issuer in the /verify issuance response.
  printf '%s' "$status_json" | grep -q '"demo":true'         || { echo 'FAIL: demo mode is off'; exit 1; }
  printf '%s' "$status_json" | grep -q '"sandboxBits":true'  || { echo 'FAIL: sandbox bits are off'; exit 1; }
  printf '%s' "$status_json" | grep -q '"issuer":{"configured":true' || { echo 'FAIL: no issuer key'; exit 1; }
  echo 'ok: demo tier on, sandbox regime on, issuer key present'
fi

# --- scene 4 — the Sepolia issuance transaction -------------------------------------------------
# Copy onchain.txHash out of the /verify result panel and open it. Export SEPOLIA_TX to have the
# URL printed for you.

if want 4; then
  banner 4 "the Sepolia issuance transaction"
  echo "explorer: $SEPOLIA_EXPLORER/address/$SRC   (ComplianceSource, Sepolia)"
  if [ -n "$SEPOLIA_TX" ]; then
    : "${DEMO_ISSUANCE_SUBJECT:?provide the subject from the reviewed issuance record}"
    : "${DEMO_ISSUANCE_TX_TO:?provide the reviewed outer transaction destination, source or issuer account}"
    : "${DEMO_ISSUANCE_ATTRS:?provide the exact issued attrs bytes32}"
    : "${DEMO_ISSUANCE_CLAIMS_ROOT:?provide the original claimsRoot bytes32}"
    : "${DEMO_ISSUANCE_EVIDENCE_HASH:?provide the original evidenceHash bytes32}"
    : "${DEMO_SOURCE_CONFIRMATIONS:?provide the approved positive source confirmation depth}"
    echo "issuance: $SEPOLIA_EXPLORER/tx/$SEPOLIA_TX"
    # RECORD=1 has no pinned state snapshot; observe its current source head for this receipt only.
    receipt_head="$SEP_BLOCK"
    if [ -z "$receipt_head" ]; then
      receipt_pin="$(command cast block latest --json --rpc-url "$SEP" | node "$repo_dir/script/demo-block.mjs" pin)"
      read -r receipt_head unused_receipt_head_hash <<< "$receipt_pin"
    fi
    issuance_pin="$(cast receipt "$SEPOLIA_TX" --json --rpc-url "$SEP" | node "$repo_dir/script/demo-issuance.mjs" \
      "$SEPOLIA_TX" "$SRC" "$DEMO_ISSUANCE_TX_TO" "$DEMO_EXPECTED_ISSUER" "$DEMO_ISSUANCE_SUBJECT" "$DEMO_ISSUANCE_ATTRS" \
      "$DEMO_ISSUANCE_CLAIMS_ROOT" "$DEMO_ISSUANCE_EVIDENCE_HASH" "$receipt_head" "$DEMO_SOURCE_CONFIRMATIONS")"
    read -r ISSUANCE_BLOCK ISSUANCE_BLOCK_HASH ISSUANCE_TX_INDEX ISSUANCE_LOG_POSITION <<< "$issuance_pin"
    command cast block "$ISSUANCE_BLOCK" --json --rpc-url "$SEP" | node "$repo_dir/script/demo-block.mjs" check "$ISSUANCE_BLOCK" "$ISSUANCE_BLOCK_HASH"
    printf 'PASS: exact source issuance event at block=%s txIndex=%s receiptLog=%s\n' "$ISSUANCE_BLOCK" "$ISSUANCE_TX_INDEX" "$ISSUANCE_LOG_POSITION"
    # -> status 1 (success); gasUsed near the 27,933 measured for ComplianceSource.issue()
  else
    echo 'FAIL: scene 4 requires the actual SEPOLIA_TX; no transaction receipt was verified' >&2
    exit 1
  fi
fi

# --- scene 6 — the verifier, and one mark under two policies ------------------------------------

if want 6; then
  banner 6 "Creditcoin verdicts"

  cast code $ASC --rpc-url "$CC3" | wc -c     # non-empty ProofmarkASC runtime on Creditcoin
  cast code $SRC --rpc-url "$SEP" | wc -c     # non-empty ComplianceSource runtime on Sepolia

  # The ASC accepts a proof from one source chain and one source contract only.
  cast call $ASC 'expectedChainKey()(uint64)' --rpc-url "$CC3"   # -> 1   Sepolia
  cast call $ASC 'sourceContract()(address)'  --rpc-url "$CC3"   # -> 0xfb46D722CD70F1ed399616a9B4745E60B9220609

  # The same mark, two policies, two answers. This is the portability claim, on chain.
  assert_call 'holder production rejection' false "$REG" 'isVerified(address,uint256)(bool)' "$SUB" 1 --rpc-url "$CC3"
  assert_call 'holder pilot eligibility' true "$REG" 'isVerified(address,uint256)(bool)' "$SUB" 2 --rpc-url "$CC3"

  # Policy 1, re-read from chain. Nothing here was relaxed to make anything pass.
  cast call $REG 'policies(uint256)(uint32,uint8,uint40,uint16,uint16,address,bool,bool)' 1 --rpc-url "$CC3"
  # -> 65572 [6.557e4]   requireAll 0x10024 = ID_DOC_AUTHENTICITY|BANK_ACCOUNT|SANCTIONS_SCREENED
  # -> 2                 minAssurance
  # -> 2592000 / 1 / 410 / issuer / false / true
  cast call $REG 'policyFrozen(uint256)(bool)' 1 --rpc-url "$CC3"  # -> true
  cast call $REG 'policyFrozen(uint256)(bool)' 2 --rpc-url "$CC3"  # -> true

  # Record-time only: the mark issued through /verify before the labelled cut has now crossed.
  if [ "${RECORD:-0}" = "1" ]; then
    : "${TAKE_B_SUBJECT:?export the subject address of the mark pre-issued through /verify — PREFLIGHT step (i)}"
    assert_call 'take-B pilot eligibility' true "$REG" 'isVerified(address,uint256)(bool)' "$TAKE_B_SUBJECT" 2 --rpc-url "$CC3"
    cast call $ASC "$MARK_TUPLE" "$TAKE_B_SUBJECT" --rpc-url "$CC3"
    # -> status 1 ACTIVE, origin 1 Direct, kind 1, assurance 3, regime 2 sandbox, jurisdiction 410 KR
  fi
fi

# --- scene 7 — GatedRwaNote refuses, then allows -------------------------------------------------

if want 7; then
  banner 7 "the gate"

  # The token's own preflight view, before anyone spends gas.
  assert_call 'control transfer rejected' false "$NOTE" 'canTransfer(address,address)(bool)' "$RWA_HOLDER" "$RWA_CONTROL" --rpc-url "$CC3"
  assert_call 'holder transfer eligible' true "$NOTE" 'canTransfer(address,address)(bool)' "$RWA_HOLDER" "$RWA_RECIPIENT" --rpc-url "$CC3"

  # The revert itself, reproduced as a call so it costs nothing. --from is what exercises the gate:
  # without it msg.sender is zero, onlyOwner fires first, and you get OwnableUnauthorizedAccount
  # (0x118cdaa7) instead of the gate's RecipientNotVerified (0x17887111).
  if out="$(cast call $NOTE 'transfer(address,uint256)' "$RWA_CONTROL" $ONE --from "$RWA_HOLDER" --rpc-url "$CC3" 2>&1)"; then
    echo "FAIL: the gate let an unverified recipient through: $out"; exit 1
  fi
  expected_revert="0x17887111$(cast abi-encode 'f(address,uint256)' "$RWA_CONTROL" 2 | cut -c3-)"
  printf '%s\n' "$out" | assert_output revert 'recipient rejection with exact subject/policy' "$expected_revert"
  # -> 0x17887111   RecipientNotVerified(..., 2)   the gate, not onlyOwner

  # And the transfer the gate allows, also as a call, also free.
  assert_call 'allowed transfer simulation' true "$NOTE" 'transfer(address,uint256)(bool)' "$RWA_RECIPIENT" "$ONE" --from "$RWA_HOLDER" --rpc-url "$CC3"

  # Balances before anything moves.
  cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_HOLDER"    --rpc-url "$CC3"  # -> 60000000000000000000 [6e19]
  cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_RECIPIENT" --rpc-url "$CC3"  # -> 40000000000000000000 [4e19]

  # Record-time only: the same two transfers as real transactions, so the revert and the success
  # both land on chain in front of the camera. A's key is testnet-only and lives in the gitignored
  # root .env as DEMO_SUBJECT_A_KEY. Estimation refuses the reverting one, so force the gas limit.
  if [ "${RECORD:-0}" = "1" ]; then
    : "${DEMO_SUBJECT_A_KEY:?export from the gitignored root .env — the testnet-only key for the holder A}"
    echo '--- the gate refuses, on chain'
    refused="$(cast send $NOTE 'transfer(address,uint256)' "$RWA_CONTROL" $ONE \
      --gas-limit 200000 --private-key "$DEMO_SUBJECT_A_KEY" --rpc-url "$CC3" 2>&1 || true)"
    printf '%s\n' "$refused" | grep -Ei 'status|transactionHash|revert' || printf '%s\n' "$refused"
    # -> status 0 (failed). Reverted on chain, gas spent, no tokens moved

    echo '--- the gate allows, on chain'
    cast send $NOTE 'transfer(address,uint256)' "$RWA_RECIPIENT" $ONE \
      --private-key "$DEMO_SUBJECT_A_KEY" --rpc-url "$CC3" | grep -Ei 'status|transactionHash|blockNumber'
    # -> status 1 (success)

    cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_RECIPIENT" --rpc-url "$CC3"  # -> 41000000000000000000 [4.1e19]
    echo "explorer: $CC3_EXPLORER/address/$NOTE"
  fi
fi

# --- scene 8 — denial and what is actually stored ------------------------------------------------

if want 8; then
  banner 8 "fail-closed control, and no cleartext personal data"

  # An address with no mark fails closed under both policies.
  assert_call 'control has no tombstone' false "$ASC" 'tombstone(address)(bool)' "$RWA_CONTROL" --rpc-url "$CC3"
  assert_call 'control production rejection' false "$REG" 'isVerified(address,uint256)(bool)' "$RWA_CONTROL" 1 --rpc-url "$CC3"
  assert_call 'control pilot rejection' false "$REG" 'isVerified(address,uint256)(bool)' "$RWA_CONTROL" 2 --rpc-url "$CC3"

  # The whole mark. Field order matters: status, origin, kind, assurance, regime, jurisdiction, methods.
  cast call $ASC "$MARK_TUPLE" $SUB --rpc-url "$CC3"
  # -> status 1 ACTIVE, origin 1 Direct, kind 1, assurance 3, regime 2 sandbox, jurisdiction 410 KR,
  #    methods 0x190027. Two 32-byte commitments and an issuer address. No name, no date of birth,
  #    no document number, no account number.
  echo "the /onchain page renders the same two subjects: $DEMO_URL/onchain"
fi

if [ "$RECORD" = 0 ]; then
  if [ -n "$ISSUANCE_BLOCK" ]; then
    command cast block "$ISSUANCE_BLOCK" --json --rpc-url "$SEP" | node "$repo_dir/script/demo-block.mjs" check "$ISSUANCE_BLOCK" "$ISSUANCE_BLOCK_HASH"
  fi
  if [ -n "${CC3_BLOCK:-}" ]; then
    command cast block "$CC3_BLOCK" --json --rpc-url "$CC3" | node "$repo_dir/script/demo-block.mjs" check "$CC3_BLOCK" "$CC3_BLOCK_HASH"
    command cast block "$SEP_BLOCK" --json --rpc-url "$SEP" | node "$repo_dir/script/demo-block.mjs" check "$SEP_BLOCK" "$SEP_BLOCK_HASH"
  fi
  printf '\nread-only scene checks complete (SCENES=%s)\n' "$SCENES"
else printf '\nrecording commands complete; write mode was enabled (SCENES=%s)\n' "$SCENES"; fi
