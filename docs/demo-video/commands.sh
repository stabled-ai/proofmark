#!/usr/bin/env bash
#
# Proofmark demo video — historical scene commands for the retired v1 testnet deployment.
#
# Every block is labelled with the SHOTLIST.md scene it belongs to. Run the whole file before
# recording to confirm the chain still says what NARRATION.md claims:
#
#   bash docs/demo-video/commands.sh
#
# Run one scene's block on camera:
#
#   SCENES=5 bash docs/demo-video/commands.sh
#   SCENES="5 6" bash docs/demo-video/commands.sh
#
# Two modes:
#
#   default (RECORD unset)  read-only. No transaction is sent, no chain state changes, no secret is
#                           read, no variable has to be exported. Run this before recording; the
#                           "# ->" comments are what it printed on 2026-09-07.
#   RECORD=1                adds the record-time blocks: the live transfer in scene 6 and the
#                           revocation in scene 7. Each says which exported variable it needs.
#
# Cast gotchas, repeated next to the commands they bite:
#   * pass --from on a gated call, or msg.sender is zero and onlyOwner fires before the gate
#   * "missing field mixHash" from cast on CC3 is harmless; Creditcoin runs a Substrate block format
#
# This file targets the retired deployment in deployments/cc3-testnet-v1.json. The strict v2 checks for the
# post-migration contracts live in commands-v2.sh and are not used for this recording.

set -euo pipefail

# --- what the video points at -------------------------------------------------------------------

CC3="${CC3:-https://rpc.cc3-testnet.creditcoin.network}"        # chainId 102031
SEP="${SEP:-https://ethereum-sepolia-rpc.publicnode.com}"       # chainId 11155111
DEMO_URL="${DEMO_URL:-https://attest-kyc.stabled.ai}"           # the hosted demo
SEPOLIA_EXPLORER="https://sepolia.etherscan.io"
CC3_EXPLORER="https://creditcoin-testnet.blockscout.com"

ASC=0x3C6Fe016645CA52952E29C66E435bDa7F611b242   # ProofmarkASC, CC3
REG=0x2F4E5e1270f90E51251651caf08547393e3C0572   # ProofmarkRegistry, CC3
NOTE=0xa74aB3De359a55A729f9185Fe4Afe90526E585CA  # GatedRwaNote "KR Pilot Credit Note" / KPCN, POLICY_ID 2
SRC=0xA9A34586303b9fD92e090F9bb1D332DC854c72B9   # ComplianceSource, Sepolia

# Cast. All three exist on chain from the gate run recorded in README section "Live cross-chain evidence".
RWA_HOLDER="${RWA_HOLDER:-0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2}"       # A: holds KPCN, passes policy 2, fails policy 1
RWA_RECIPIENT="${RWA_RECIPIENT:-0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee}" # B: holds KPCN, passes policy 2
RWA_CONTROL="${RWA_CONTROL:-0x00000000000000000000000000000000DeaDBeef}"     # never issued, passes nothing

# Optional: the Sepolia tx hash the on-camera /verify issuance returned (scene 3).
SEPOLIA_TX="${SEPOLIA_TX:-}"

TEN=10000000000000000000  # 10 KPCN, 18 decimals
ONE=1000000000000000000   # 1 KPCN

MARK_TUPLE='getMark(address)((uint8,uint8,uint8,uint8,uint16,uint16,uint32,uint40,uint40,uint32,bytes32,bytes32,address))'
SEL_RECIPIENT=0x17887111   # RecipientNotVerified(address,uint256)
SEL_SENDER=0x8677c1af      # SenderNotVerified(address,uint256)
SEL_OWNABLE=0x118cdaa7     # OwnableUnauthorizedAccount — the wrong error; means --from was missing

SCENES="${SCENES:-all}"
RECORD="${RECORD:-0}"

want() { case " $SCENES " in *" all "*) return 0 ;; *" $1 "*) return 0 ;; *) return 1 ;; esac; }
banner() { printf '\n=== scene %s — %s\n' "$1" "$2"; }
verified() { cast call $REG 'isVerified(address,uint256)(bool)' "$1" "$2" --rpc-url "$CC3"; }

# --- scene 1 — cold open: the refusal ------------------------------------------------------------
# The footage is scene 6's refusal, cut to the front. This block reproduces it as a free call.

if want 1; then
  banner 1 "cold open — the note refuses an unverified wallet"
  cast call $NOTE 'canTransfer(address,address)(bool)' "$RWA_HOLDER" "$RWA_CONTROL" --rpc-url "$CC3"   # -> false
  if out="$(cast call $NOTE 'transfer(address,uint256)' "$RWA_CONTROL" $ONE --from "$RWA_HOLDER" --rpc-url "$CC3" 2>&1)"; then
    echo "FAIL: the gate let an unverified recipient through: $out"; exit 1
  fi
  printf '%s\n' "$out" | grep -o "${SEL_RECIPIENT}[0-9a-f]*" | cut -c1-10   # -> 0x17887111  RecipientNotVerified
fi

# --- scene 2 — live sanctions screening ---------------------------------------------------------
# On camera this is the browser at $DEMO_URL/ using the "Kim Jong Un · KP" preset. Same request here.

if want 2; then
  banner 2 "live sanctions screening"
  curl -fsS --max-time 30 -X POST "$DEMO_URL/api/screen" \
    -H 'content-type: application/json' \
    -d '{"fullName":"Kim Jong Un","dateOfBirth":"1984-01-08","nationality":"KP"}' \
    | tr ',' '\n' | grep -E '"decision"|"riskBand"|"listId"|"entryId"|"corroborated"' | head -6
  # -> "decision":"BLOCK"   "riskBand":5   "listId":"OFAC_SDN"   "entryId":"20157"
fi

# --- scene 3 — hosted verification boundary -----------------------------------------------------
# The v1 recording originally used labelled demo id and bank adapters with sandbox issuance. The
# hosted product may instead expose the separate Sumsub Sandbox evidence-only flow. That flow must
# remain test-only and must not claim that it issues a Proofmark credential.

if want 3; then
  banner 3 "what the hosted deployment is configured to run"
  status_json="$(curl -fsS --max-time 30 "$DEMO_URL/api/kyc/status")"
  printf '%s\n' "$status_json" | tr ',' '\n' | grep -E '"demo"|"sandboxBits"|"vendor"|"live"|"configured"' | head -9
  if printf '%s' "$status_json" | grep -q '"demo":true'; then
    # -> "demo":true  "sandboxBits":true  "vendor":"demo:id"  "vendor":"demo:bank"  "live":false  "configured":true
    printf '%s' "$status_json" | grep -q '"sandboxBits":true'          || { echo 'FAIL: sandbox bits are off'; exit 1; }
    printf '%s' "$status_json" | grep -q '"issuer":{"configured":true' || { echo 'FAIL: no issuer key'; exit 1; }
    echo 'ok: demo tier on, sandbox regime on, issuer key present'
  else
    provider_json="$(curl -fsS --max-time 30 "$DEMO_URL/api/providers/sumsub/status")"
    printf '%s\n' "$provider_json" | tr ',' '\n' | grep -E '"configured"|"environment"|"testOnly"|"mode"|"issuanceBridge"'
    printf '%s' "$provider_json" | grep -q '"configured":true'                 || { echo 'FAIL: provider is not configured'; exit 1; }
    printf '%s' "$provider_json" | grep -q '"environment":"sandbox"'         || { echo 'FAIL: provider is not in sandbox'; exit 1; }
    printf '%s' "$provider_json" | grep -q '"testOnly":true'                  || { echo 'FAIL: provider does not enforce test-only disclosure'; exit 1; }
    printf '%s' "$provider_json" | grep -q '"mode":"evidence-candidate-only"' || { echo 'FAIL: provider mode is not evidence-only'; exit 1; }
    printf '%s' "$provider_json" | grep -q '"issuanceBridge":false'           || { echo 'FAIL: provider unexpectedly enables issuance'; exit 1; }
    echo 'ok: Sumsub sandbox is test-only, evidence-only and disconnected from issuance'
  fi
  echo "source contract on Sepolia: $SEPOLIA_EXPLORER/address/$SRC"
  if [ -n "$SEPOLIA_TX" ]; then
    echo "issuance: $SEPOLIA_EXPLORER/tx/$SEPOLIA_TX"
    cast receipt "$SEPOLIA_TX" --rpc-url "$SEP" 2>/dev/null | grep -E '^(status|gasUsed|blockNumber)' || true
    # -> status 1 (success); gasUsed near the 27,933 measured for ComplianceSource.issue()
  fi
fi

# --- scene 4 — the crossing ----------------------------------------------------------------------
# The caption covers the wait. What the camera shows after the cut is $DEMO_URL/onchain for holder A
# and the verifier's pins: one source chain, one source contract.

if want 4; then
  banner 4 "the mark on Creditcoin, and what the verifier accepts"
  cast call $ASC 'expectedChainKey()(uint64)' --rpc-url "$CC3"   # -> 1   Sepolia
  cast call $ASC 'sourceContract()(address)'  --rpc-url "$CC3"   # -> 0xA9A34586303b9fD92e090F9bb1D332DC854c72B9
  cast call $ASC "$MARK_TUPLE" "$RWA_HOLDER" --rpc-url "$CC3"
  # -> (1 ACTIVE, 1 Direct, 1 individual, assurance 3, regime 2 sandbox, 410 KR, methods 0x190027,
  #     issuedAt, expiresAt, epoch, claimsRoot, evidenceHash, issuer). Two commitments; no cleartext.
  echo "on camera: $DEMO_URL/onchain"
fi

# --- scene 5 — one mark, two policies, two answers -----------------------------------------------

if want 5; then
  banner 5 "Creditcoin verdicts"
  verified "$RWA_HOLDER" 1   # -> false  policy 1, KR production: regime mismatch, the mark says sandbox
  verified "$RWA_HOLDER" 2   # -> true   policy 2, KR sandbox pilot
  cast call $REG 'policyFrozen(uint256)(bool)' 1 --rpc-url "$CC3"  # -> true
  cast call $REG 'policyFrozen(uint256)(bool)' 2 --rpc-url "$CC3"  # -> true
  # Policy 1, re-read from chain. Nothing was relaxed to make anything pass.
  cast call $REG 'policies(uint256)(uint32,uint8,uint40,uint16,uint16,address,bool,bool)' 1 --rpc-url "$CC3"
  # -> 65572 = 0x10024 requireAll (ID_DOC_AUTHENTICITY | BANK_ACCOUNT | SANCTIONS_SCREENED)
  # -> 2 minAssurance · 2592000 (30 d) · regime 1 · 410 · issuer · false · true (frozen)
  [ "$(verified "$RWA_HOLDER" 1)" = false ] || { echo 'FAIL: holder passes production policy'; exit 1; }
  [ "$(verified "$RWA_HOLDER" 2)" = true ]  || { echo 'FAIL: holder no longer passes pilot policy — re-issue (PREFLIGHT h)'; exit 1; }
fi

# --- scene 6 — the gate: verified to verified moves, unverified reverts --------------------------

if want 6; then
  banner 6 "the gate"
  cast call $NOTE 'canTransfer(address,address)(bool)' "$RWA_HOLDER" "$RWA_RECIPIENT" --rpc-url "$CC3"  # -> true
  cast call $NOTE 'canTransfer(address,address)(bool)' "$RWA_HOLDER" "$RWA_CONTROL"   --rpc-url "$CC3"  # -> false
  cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_HOLDER"    --rpc-url "$CC3"   # -> 60000000000000000000 [6e19] on 2026-09-07
  cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_RECIPIENT" --rpc-url "$CC3"   # -> 40000000000000000000 [4e19]

  # The refusal, as a call so it costs nothing. --from is what exercises the gate.
  if out="$(cast call $NOTE 'transfer(address,uint256)' "$RWA_CONTROL" $ONE --from "$RWA_HOLDER" --rpc-url "$CC3" 2>&1)"; then
    echo "FAIL: the gate let an unverified recipient through: $out"; exit 1
  fi
  printf '%s\n' "$out" | grep -q "$SEL_OWNABLE" && { echo 'FAIL: OwnableUnauthorizedAccount — --from was dropped'; exit 1; }
  printf '%s\n' "$out" | grep -o "${SEL_RECIPIENT}[0-9a-f]*" | cut -c1-10   # -> 0x17887111  RecipientNotVerified(control, 2)

  # The transfer the gate allows, also as a free call.
  cast call $NOTE 'transfer(address,uint256)(bool)' "$RWA_RECIPIENT" $TEN --from "$RWA_HOLDER" --rpc-url "$CC3"   # -> true

  # Record-time only: the allowed transfer as a real transaction, so a receipt lands on camera.
  # A's key is testnet-only and lives in the gitignored root .env as DEMO_SUBJECT_A_KEY.
  if [ "$RECORD" = "1" ]; then
    : "${DEMO_SUBJECT_A_KEY:?export from the gitignored root .env — the testnet-only key for holder A}"
    echo '--- the gate allows, on chain: 10 KPCN from A to B'
    cast send $NOTE 'transfer(address,uint256)' "$RWA_RECIPIENT" $TEN \
      --private-key "$DEMO_SUBJECT_A_KEY" --rpc-url "$CC3" | grep -Ei 'status|transactionHash|blockNumber'
    # -> status 1 (success)
    cast call $NOTE 'balanceOf(address)(uint256)' "$RWA_RECIPIENT" --rpc-url "$CC3"
    echo "explorer: $CC3_EXPLORER/address/$NOTE"
  fi
fi

# --- scene 7 — revocation travels ----------------------------------------------------------------
# Order on the day: film scene 6 first. Then revoke A on Sepolia, let the worker carry it, and film
# the same transfer failing with SenderNotVerified. After this scene A is revoked; a new take needs a
# fresh issuance for A (PREFLIGHT h).

if want 7; then
  banner 7 "revocation travels"
  cast call $ASC 'tombstone(address)(bool)' "$RWA_HOLDER" --rpc-url "$CC3"   # -> false before the revocation
  echo "reason codes: 1 USER_REQUEST · 2 RESCREEN_HIT · 3 DOC_EXPIRED · 4 ISSUER_ERROR · 5 RISK_ESCALATED"

  if [ "$RECORD" = "1" ]; then
    : "${DEPLOYER_PRIVATE_KEY:?export from the gitignored root .env — the ComplianceSource issuer key}"
    [ "$(cast call $ASC 'tombstone(address)(bool)' "$RWA_HOLDER" --rpc-url "$CC3")" = false ] \
      || { echo 'FAIL: holder is already tombstoned; re-issue before filming this scene'; exit 1; }
    epoch="$(cast call $ASC 'latestEpoch()(uint32)' --rpc-url "$CC3")"
    echo "--- the issuer revokes A on Ethereum Sepolia (reason 2, RESCREEN_HIT, epoch $epoch)"
    cast send $SRC 'revoke(address,uint16,uint32)' "$RWA_HOLDER" 2 "$epoch" \
      --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$SEP" | grep -Ei 'status|transactionHash|blockNumber'
    # -> status 1. This is the only transaction of the scene. Creditcoin is not touched.

    echo '--- waiting for Attestcoin + worker to carry MarkRevoked to CC3 (measured 8m 43s once; allow 30 min)'
    started=$(date +%s)
    until [ "$(cast call $ASC 'tombstone(address)(bool)' "$RWA_HOLDER" --rpc-url "$CC3")" = true ]; do
      sleep 30
      elapsed=$(( $(date +%s) - started ))
      printf 'waiting… %dm%02ds\n' $((elapsed/60)) $((elapsed%60))
      [ "$elapsed" -lt 1800 ] || { echo 'FAIL: not applied within 30 min — is the worker running against the live ASC?'; exit 1; }
    done
    printf 'applied after %dm%02ds — write this number into the scene 7 caption\n' $((elapsed/60)) $((elapsed%60))
  fi

  # After the crossing (read-only again). Before RECORD=1 has run these still show the active mark.
  cast call $ASC 'tombstone(address)(bool)' "$RWA_HOLDER" --rpc-url "$CC3"                          # -> true after
  verified "$RWA_HOLDER" 2                                                                            # -> false after
  cast call $NOTE 'canTransfer(address,address)(bool)' "$RWA_HOLDER" "$RWA_RECIPIENT" --rpc-url "$CC3"  # -> false after
  if out="$(cast call $NOTE 'transfer(address,uint256)' "$RWA_RECIPIENT" $ONE --from "$RWA_HOLDER" --rpc-url "$CC3" 2>&1)"; then
    echo "(transfer still allowed — revocation has not crossed yet, or RECORD=1 has not run)"
  else
    printf '%s\n' "$out" | grep -o "${SEL_SENDER}[0-9a-f]*" | cut -c1-10   # -> 0x8677c1af  SenderNotVerified(A, 2)
  fi
  echo "on camera: $DEMO_URL/onchain shows REVOKED · tombstone for the holder"
fi

# --- scene 8 — close --------------------------------------------------------------------------------

if want 8; then
  banner 8 "close"
  echo "product:   $DEMO_URL"
  echo "on-chain:  $DEMO_URL/onchain"
  echo "verify:    $DEMO_URL/verify"
  echo "source:    $SEPOLIA_EXPLORER/address/$SRC"
  echo "note:      $CC3_EXPLORER/address/$NOTE"
fi

printf '\nchecks complete (SCENES=%s, RECORD=%s)\n' "$SCENES" "$RECORD"
