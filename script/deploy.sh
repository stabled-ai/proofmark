#!/usr/bin/env bash
# Proofmark testnet deployment: CC3 Testnet (hub) and Ethereum Sepolia (source)
#
# This script sends on-chain transactions. Before running, check:
#    1) no other session is sending from this wallet (nonce collision)
#    2) both chains have balance
#
# Usage:
#    ./script/deploy.sh preflight   # checks only, no transactions
#    ./script/deploy.sh deploy      # deploy for real
#
# Order matters. ProofmarkASC needs the EvmV1Decoder library linked, and the ASC accepts
# no proof before configureSource runs (test_RejectsBeforeSourceConfigured).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${DEPLOYMENT_OUT:-$ROOT/deployments/cc3-testnet.json}"
DECODER_PATH="node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder"

# Shell variables read with `source .env` are not exported to a child process by default. Load and
# export the repository's testnet configuration here so the documented command works as written.
if [ "${DEPLOY_ENV_LOADED:-0}" != "1" ] && [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# Creditcoin USC testnet defaults. Preflight reads and validates the live chain metadata.
SOURCE_CHAIN_KEY="${SOURCE_CHAIN_KEY:-1}"     # chainKey 1 is Sepolia. Not the same as chainId 11155111.

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

need() {
  local n="$1"
  if [ -z "${!n:-}" ]; then red "x $n is not set. Did you run 'source .env'?"; exit 1; fi
}

preflight() {
  echo "=== Preflight (no transactions) ==="
  need CREDITCOIN_RPC_URL
  need SOURCE_CHAIN_RPC_URL
  need DEPLOYER_PRIVATE_KEY
  need GOVERNANCE_OWNER_PRIVATE_KEY
  need ASSET_OWNER_PRIVATE_KEY
  need SOURCE_ISSUER_ADDRESS
  need RESCREEN_SIGNER_ADDRESS
  need EPOCH_PUBLISHER_ADDRESS
  need WORKER_PAYER_ADDRESS
  need PROOFMARK_ISSUER_MODE
  need DENIAL_CORRECTION_APPROVER_ADDRESS
  need ASSET_RECOVERY_PROPOSER_ADDRESS
  need ASSET_RECOVERY_APPROVER_ADDRESS

  local addr governance_owner asset_owner
  addr=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
  governance_owner=$(cast wallet address --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY")
  asset_owner=$(cast wallet address --private-key "$ASSET_OWNER_PRIVATE_KEY")
  echo "deployer        : $addr"
  echo "governance owner: $governance_owner"
  echo "asset owner     : $asset_owner"

  local -a role_names=(deployer governance-owner source-issuer source-rescreener epoch-publisher worker-payer asset-owner denial-correction-approver asset-recovery-proposer asset-recovery-approver)
  local -a role_addresses=("$addr" "$governance_owner" "$SOURCE_ISSUER_ADDRESS" "$RESCREEN_SIGNER_ADDRESS" "$EPOCH_PUBLISHER_ADDRESS" "$WORKER_PAYER_ADDRESS" "$asset_owner" "$DENIAL_CORRECTION_APPROVER_ADDRESS" "$ASSET_RECOVERY_PROPOSER_ADDRESS" "$ASSET_RECOVERY_APPROVER_ADDRESS")
  local i j normalized_i normalized_j
  for ((i=0; i<${#role_addresses[@]}; i++)); do
    [[ "${role_addresses[$i]}" =~ ^0x[0-9a-fA-F]{40}$ && ! "${role_addresses[$i]}" =~ ^0x0{40}$ ]] \
      || { red "x invalid ${role_names[$i]} address"; exit 1; }
    normalized_i=$(echo "${role_addresses[$i]}" | tr 'A-F' 'a-f')
    for ((j=i+1; j<${#role_addresses[@]}; j++)); do
      normalized_j=$(echo "${role_addresses[$j]}" | tr 'A-F' 'a-f')
      [ "$normalized_i" != "$normalized_j" ] \
        || { red "x runtime roles ${role_names[$i]} and ${role_names[$j]} must use different principals"; exit 1; }
    done
  done
  npx --no-install tsx "$ROOT/script/check-runtime-roles.ts" "${role_addresses[@]}" >/dev/null
  grn "  ok runtime role principals are distinct"

  # T-06: this contract family stores lifecycle state by subject, not issuer scope. Require an
  # explicit product decision and refuse to label/deploy it as an isolated multi-issuer release.
  if npx --no-install tsx "$ROOT/script/check-issuer-mode.ts" "$PROOFMARK_ISSUER_MODE" "$SOURCE_ISSUER_ADDRESS"; then
    grn "  ok issuer release mode verified"
  else
    red "x issuer release mode is unsafe or undecided. Stopping before any transaction."
    exit 1
  fi

  local ccid; ccid=$(cast chain-id --rpc-url "$CREDITCOIN_RPC_URL")
  local spid; spid=$(cast chain-id --rpc-url "$SOURCE_CHAIN_RPC_URL")
  echo "CC3 chainId    : $ccid   (expect 102031)"
  echo "Sepolia chainId: $spid   (expect 11155111)"
  [ "$ccid" = "102031" ]   || { red "x CC3 chainId mismatch"; exit 1; }
  [ "$spid" = "11155111" ] || { red "x Sepolia chainId mismatch"; exit 1; }

  local ccbal spbal
  ccbal=$(cast balance "$addr" --rpc-url "$CREDITCOIN_RPC_URL" --ether)
  spbal=$(cast balance "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL" --ether)
  echo "CC3 balance    : $ccbal CTC"
  echo "Sepolia balance: $spbal ETH"

  # Print nonces so concurrent use by another session is visible
  echo "CC3 nonce    : $(cast nonce "$addr" --rpc-url "$CREDITCOIN_RPC_URL")"
  echo "Sepolia nonce: $(cast nonce "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL")"
  echo "governance CC3 nonce    : $(cast nonce "$governance_owner" --rpc-url "$CREDITCOIN_RPC_URL")"
  echo "governance Sepolia nonce: $(cast nonce "$governance_owner" --rpc-url "$SOURCE_CHAIN_RPC_URL")"
  echo "asset-owner CC3 nonce   : $(cast nonce "$asset_owner" --rpc-url "$CREDITCOIN_RPC_URL")"

  echo
  echo "Reading supported chains to verify the chainKey for configureSource($SOURCE_CHAIN_KEY, ...):"
  # chainKey is not chainId. We look it up at runtime rather than hardcoding it.
  # (cast handles struct array returns awkwardly, so this goes through the SDK)
  if npx --no-install tsx "$ROOT/script/check_chains.ts" "$SOURCE_CHAIN_KEY" 11155111; then
    grn "  ok chainKey verified"
  else
    red "x chainKey check failed. configureSource would point at the wrong chain. Stopping."
    exit 1
  fi

  grn "ok preflight passed"
  ylw "If a nonce looks wrong, another session may be using this wallet. Check before continuing."
}

deploy() {
  preflight
  echo
  ylw "Sending real transactions now. Ctrl-C within 5 seconds to stop."
  sleep 5

  cd "$ROOT"
  local addr governance_owner asset_owner
  addr=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
  governance_owner=$(cast wallet address --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY")
  asset_owner=$(cast wallet address --private-key "$ASSET_OWNER_PRIVATE_KEY")

  # 1. EvmV1Decoder library on CC3
  # The documented pre-deployed Decoder (0x731c34...F9f) has a different runtime size from
  # our build (19,199 vs 26,524 hex chars), so we deploy our own rather than assume.
  # A bad link fails quietly and costs an eight-minute attestation cycle to find.
  echo "── 1/8  EvmV1Decoder → CC3"
  local decoder
  decoder=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" "$DECODER_PATH" \
      | awk '/Deployed to:/{print $3}')
  [ -n "$decoder" ] || { red "x decoder deployment failed"; exit 1; }
  grn "   EvmV1Decoder = $decoder"

  # 2. ProofmarkASC on CC3, library link required
  echo "-- 2/8  ProofmarkASC -> CC3  (--libraries)"
  local asc
  asc=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      --libraries "${DECODER_PATH}:${decoder}" \
      src/ProofmarkASC.sol:ProofmarkASC --constructor-args "$governance_owner" \
      | awk '/Deployed to:/{print $3}')
  [ -n "$asc" ] || { red "x ASC deployment failed. Check the library link."; exit 1; }
  grn "   ProofmarkASC = $asc"

  # ── 3. ProofmarkRegistry (CC3) ────────────────────────────────────
  echo "── 3/8  ProofmarkRegistry → CC3"
  local reg
  reg=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      src/ProofmarkRegistry.sol:ProofmarkRegistry --constructor-args "$asc" \
      | awk '/Deployed to:/{print $3}')
  [ -n "$reg" ] || { red "x Registry deployment failed"; exit 1; }
  grn "   ProofmarkRegistry = $reg"

  # ── 4. ComplianceSource (Sepolia) ─────────────────────────────────
  echo "── 4/8  ComplianceSource → Sepolia"
  local srcaddr srctx srcblock srcoutput
  srcoutput=$(forge create --broadcast --rpc-url "$SOURCE_CHAIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      src/ComplianceSource.sol:ComplianceSource --constructor-args "$governance_owner")
  srcaddr=$(printf '%s\n' "$srcoutput" | awk '/Deployed to:/{print $3}')
  srctx=$(printf '%s\n' "$srcoutput" | awk '/Transaction hash:/{print $3}')
  [[ "$srcaddr" =~ ^0x[0-9a-fA-F]{40}$ && "$srctx" =~ ^0x[0-9a-fA-F]{64}$ ]] || { red "x source deployment address/transaction missing; preserve deployment output and reconcile before continuing"; exit 1; }
  srcblock=$(cast receipt "$srctx" blockNumber --rpc-url "$SOURCE_CHAIN_RPC_URL")
  [[ "$srcblock" =~ ^[1-9][0-9]*$ ]] || { red "x source deployment block missing"; exit 1; }
  grn "   ComplianceSource = $srcaddr"

  # 5. Cross-registration
  # The ASC rejects every proof until configureSource runs. Fail closed by design.
  echo "── 5/8  asc.configureSource(chainKey=$SOURCE_CHAIN_KEY, $srcaddr)"
  cast send "$asc" "configureSource(uint64,address)" "$SOURCE_CHAIN_KEY" "$srcaddr" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null
  grn "   configureSource done"

  echo "── 6/8  source issuer, epoch publisher and denial-correction approver"
  cast send "$srcaddr" "setIssuer(address,bool)" "$SOURCE_ISSUER_ADDRESS" true \
      --rpc-url "$SOURCE_CHAIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null
  cast send "$srcaddr" "setIssuer(address,bool)" "$RESCREEN_SIGNER_ADDRESS" true \
      --rpc-url "$SOURCE_CHAIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null
  cast send "$srcaddr" "setEpochPublisher(address,bool)" "$EPOCH_PUBLISHER_ADDRESS" true \
      --rpc-url "$SOURCE_CHAIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null
  cast send "$srcaddr" "setDenialCorrectionApprover(address,bool)" "$DENIAL_CORRECTION_APPROVER_ADDRESS" true \
      --rpc-url "$SOURCE_CHAIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null
  grn "   issuer, epoch publisher and separate correction approver registered"

  # 7. Policies. Production pins live regime 1; pilot pins sandbox regime 2. Both pin KR
  # jurisdiction and this issuer, and are frozen before an asset can bind to them.
  # KR VASP methods: document authenticity | bank account | sanctions screening
  #   ID_DOC_AUTHENTICITY(1<<2) | BANK_ACCOUNT(1<<5) | SANCTIONS_SCREENED(1<<16) = 0x10024
  echo "-- 7/8  register and freeze KR production + pilot policies -> Registry"
  local krmask=$((1<<2 | 1<<5 | 1<<16))
  cast send "$reg" "registerPolicyForKind((uint32,uint8,uint40,uint16,uint16,address,bool,bool),uint8)" \
      "($krmask,2,2592000,1,410,$SOURCE_ISSUER_ADDRESS,true,false)" 1 \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null
  local productionpolicy; productionpolicy=$(cast call "$reg" "nextPolicyId()(uint256)" --rpc-url "$CREDITCOIN_RPC_URL")
  productionpolicy=$(( ${productionpolicy%% *} - 1 ))
  cast send "$reg" "freezePolicy(uint256)" "$productionpolicy" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null

  cast send "$reg" "registerPolicyForKind((uint32,uint8,uint40,uint16,uint16,address,bool,bool),uint8)" \
      "($krmask,2,604800,2,410,$SOURCE_ISSUER_ADDRESS,true,false)" 1 \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null
  local pilotpolicy; pilotpolicy=$(cast call "$reg" "nextPolicyId()(uint256)" --rpc-url "$CREDITCOIN_RPC_URL")
  pilotpolicy=$(( ${pilotpolicy%% *} - 1 ))
  cast send "$reg" "freezePolicy(uint256)" "$pilotpolicy" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$GOVERNANCE_OWNER_PRIVATE_KEY" >/dev/null
  grn "   production policyId = $productionpolicy (regime 1, 30d)"
  grn "   pilot policyId      = $pilotpolicy (regime 2, 7d)"

  # 8. Demo token on CC3
  echo "── 8/8  GatedRwaNote → CC3"
  local note
  note=$(forge create --broadcast --rpc-url "$CREDITCOIN_RPC_URL" \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      src/GatedRwaNote.sol:GatedRwaNote \
      --constructor-args "KR Pilot Credit Note" "KPCN" "$reg" "$pilotpolicy" "$asset_owner" \
      | awk '/Deployed to:/{print $3}')
  [ -n "$note" ] || { red "x GatedRwaNote deployment failed"; exit 1; }
  cast send "$note" "configureRecoveryGovernance(address,address)" \
      "$ASSET_RECOVERY_PROPOSER_ADDRESS" "$ASSET_RECOVERY_APPROVER_ADDRESS" \
      --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$ASSET_OWNER_PRIVATE_KEY" >/dev/null
  grn "   GatedRwaNote = $note"

  # Record
  cat > "$OUT" <<JSON
{
  "release": "v2-live",
  "network": { "hub": "cc3-testnet", "hubChainId": 102031, "source": "sepolia", "sourceChainId": 11155111 },
  "sourceChainKey": $SOURCE_CHAIN_KEY,
  "issuerMode": "$PROOFMARK_ISSUER_MODE",
  "sourceDeployment": { "transactionHash": "$srctx", "blockNumber": $srcblock },
  "deployer": "$addr",
  "roles": {
    "governanceOwner": "$governance_owner",
    "sourceIssuer": "$SOURCE_ISSUER_ADDRESS",
    "sourceRescreener": "$RESCREEN_SIGNER_ADDRESS",
    "epochPublisher": "$EPOCH_PUBLISHER_ADDRESS",
    "workerPayer": "$WORKER_PAYER_ADDRESS",
    "assetOwner": "$asset_owner"
  },
  "governance": {
    "denialCorrectionApprover": "$DENIAL_CORRECTION_APPROVER_ADDRESS",
    "assetRecoveryProposer": "$ASSET_RECOVERY_PROPOSER_ADDRESS",
    "assetRecoveryApprover": "$ASSET_RECOVERY_APPROVER_ADDRESS"
  },
  "contracts": {
    "EvmV1Decoder":      "$decoder",
    "ProofmarkASC":      "$asc",
    "ProofmarkRegistry": "$reg",
    "ComplianceSource":  "$srcaddr",
    "GatedRwaNote":      "$note"
  },
  "demo": {
    "productionPolicyId": $productionpolicy,
    "pilotPolicyId": $pilotpolicy,
    "notePolicyId": $pilotpolicy
  }
}
JSON
  grn "ok deployed, written to $OUT"
  cat "$OUT"

  # Post-deployment checks
  echo
  echo "=== Post-deployment checks ==="
  echo -n "asc.expectedChainKey : "; cast call "$asc" "expectedChainKey()(uint64)"  --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "asc.sourceContract   : "; cast call "$asc" "sourceContract()(address)"   --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "reg.ASC              : "; cast call "$reg" "ASC()(address)"              --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "note.POLICY_ID       : "; cast call "$note" "POLICY_ID()(uint256)"       --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "reg.policyFrozen(1) : "; cast call "$reg" "policyFrozen(uint256)(bool)" 1 --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "reg.policyFrozen(2) : "; cast call "$reg" "policyFrozen(uint256)(bool)" 2 --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "asc.owner              : "; cast call "$asc" "owner()(address)" --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "source.owner           : "; cast call "$srcaddr" "owner()(address)" --rpc-url "$SOURCE_CHAIN_RPC_URL"
  echo -n "note.owner             : "; cast call "$note" "owner()(address)" --rpc-url "$CREDITCOIN_RPC_URL"
  echo -n "src.isIssuer(deployer) : "; cast call "$srcaddr" "isIssuer(address)(bool)" "$addr" --rpc-url "$SOURCE_CHAIN_RPC_URL"
  echo -n "src.isIssuer(dedicated): "; cast call "$srcaddr" "isIssuer(address)(bool)" "$SOURCE_ISSUER_ADDRESS" --rpc-url "$SOURCE_CHAIN_RPC_URL"
  echo -n "src.isIssuer(rescreener): "; cast call "$srcaddr" "isIssuer(address)(bool)" "$RESCREEN_SIGNER_ADDRESS" --rpc-url "$SOURCE_CHAIN_RPC_URL"
  echo -n "src.publisher(dedicated): "; cast call "$srcaddr" "isEpochPublisher(address)(bool)" "$EPOCH_PUBLISHER_ADDRESS" --rpc-url "$SOURCE_CHAIN_RPC_URL"

  # Same deployer and same nonce give the same CREATE address on different chains.
  # When that happens, passing the wrong address to configureSource looks identical,
  # so compare the bytecode on both chains to confirm they are different contracts.
  echo
  echo "=== Address collision check (ASC vs ComplianceSource) ==="
  if [ "$(echo "$asc" | tr 'A-Z' 'a-z')" = "$(echo "$srcaddr" | tr 'A-Z' 'a-z')" ]; then
    ylw "  addresses match. Comparing bytecode on each chain."
    local ccode scode
    ccode=$(cast code "$asc"     --rpc-url "$CREDITCOIN_RPC_URL"  | wc -c | tr -d ' ')
    scode=$(cast code "$srcaddr" --rpc-url "$SOURCE_CHAIN_RPC_URL" | wc -c | tr -d ' ')
    echo "  CC3     : $ccode chars"
    echo "  Sepolia : $scode chars"
    if [ "$ccode" = "$scode" ]; then
      red "x bytecode is identical on both chains. configureSource may point at the wrong contract."; exit 1
    fi
    grn "  ok different contracts confirmed"
  fi

  # Check the gate is closed rather than just saying so
  #
  # `cast call` leaves msg.sender at 0, so without the asset owner's --from the onlyOwner check
  # fires first. The deployer is intentionally not the asset owner.
  # OwnableUnauthorizedAccount (0x118cdaa7) and RecipientNotVerified (0x17887111) both look
  # like a revert but mean different things, so compare the selector.
  echo
  echo "=== Gate closure check (nobody is verified yet) ==="
  local gateout
  gateout=$(cast call "$note" "mint(address,uint256)" "$addr" 1000000000000000000 \
              --from "$asset_owner" --rpc-url "$CREDITCOIN_RPC_URL" 2>&1 || true)
  if echo "$gateout" | grep -q "17887111\|RecipientNotVerified"; then
    grn "  ok RecipientNotVerified. The gate is closed, as expected."
  elif echo "$gateout" | grep -q "118cdaa7\|OwnableUnauthorized"; then
    red "  x OwnableUnauthorizedAccount. The asset-owner --from is missing or wrong, so the gate was not verified."; exit 1
  else
    red "  x unexpected result: $gateout"; exit 1
  fi

  echo
  grn "Deployed with a closed fresh-roster gate. Next: issue, publish an issuer-authorized bounded epoch, relay it, then cache each holder's current roster witness. Direct issuance alone cannot open note.mint."
  ylw "When reproducing: always pass --from to cast call. Without it onlyOwner fires first and you draw the wrong conclusion."
  ylw "The 'missing field mixHash' errors from forge/cast on CC3 come from the Substrate block format and are harmless."
}

case "${1:-preflight}" in
  preflight) preflight ;;
  deploy) deploy ;;
  *) echo "usage: $0 [preflight|deploy]" >&2; exit 2 ;;
esac
