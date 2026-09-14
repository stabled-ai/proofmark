#!/usr/bin/env bash
#
# Pre-submission health check for the Proofmark public demo.
#
# Stable production URL (a project domain on the Vercel project stabled-ai/proofmark, so it
# follows every production promotion instead of being pinned to one deployment):
#
#   https://attest-kyc.stabled.ai
#
# Second project domain on the same project, serving the same production build. Kept as a
# fallback so a submission is never left without a working link:
#
#   https://proofmark-swart.vercel.app
#
# Run it with no arguments before submitting, or pass base URLs to check only those:
#
#   bash scripts/check-demo-urls.sh
#   bash scripts/check-demo-urls.sh https://attest-kyc.stabled.ai
#
# Six checks per base URL: the three pages a judge clicks, and the three API routes behind them.
# A check passes only if curl itself exits 0 (so a dead TLS certificate fails rather than being
# reported as a pass) and the final HTTP status is 200. Page checks follow a bounded redirect so
# canonical entry routes such as /verify can select their current first step. The two JSON routes
# are also checked for a field that is always present in their response, so an empty 200 cannot pass.
#
# Needs no secrets and no environment variables.

set -u

# Checked when the script is run with no arguments. Edit this list as the hosted URLs change —
# for example, drop a domain here if its certificate is not in place before submission.
BASE_URLS=(
  "https://attest-kyc.stabled.ai"
  "https://proofmark-swart.vercel.app"
)

SUBJECT="0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2"
SCREEN_BODY='{"fullName":"Kim Jong Un"}'
TIMEOUT=30

passed=0
failed=0

tmp_body="$(mktemp "${TMPDIR:-/tmp}/proofmark-check-body.XXXXXX")"
tmp_err="$(mktemp "${TMPDIR:-/tmp}/proofmark-check-err.XXXXXX")"
trap 'rm -f "$tmp_body" "$tmp_err"' EXIT

# check <METHOD> <URL> [required-body-substring]
check() {
  local method="$1" url="$2" needle="${3-}"
  local status rc reason

  : > "$tmp_body"
  : > "$tmp_err"

  if [ "$method" = "POST" ]; then
    status="$(curl -sS -o "$tmp_body" -w '%{http_code}' --max-time "$TIMEOUT" \
      -X POST "$url" -H 'content-type: application/json' --data "$SCREEN_BODY" 2>"$tmp_err")"
    rc=$?
  else
    status="$(curl -sS -L --max-redirs 5 -o "$tmp_body" -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>"$tmp_err")"
    rc=$?
  fi

  reason=""
  if [ "$rc" -ne 0 ]; then
    # curl exit 35 is the TLS handshake failing, 6 is DNS, 28 is the timeout. Print curl's own
    # message so a certificate problem is never mistaken for an application problem.
    reason="curl exit $rc: $(tr -d '\r' < "$tmp_err" | sed -n '1p')"
  elif [ "$status" != "200" ]; then
    reason="HTTP $status, expected 200"
  elif [ -n "$needle" ] && ! grep -q -- "$needle" "$tmp_body"; then
    reason="HTTP 200 but the body is missing \"$needle\""
  fi

  if [ -z "$reason" ]; then
    passed=$((passed + 1))
    printf 'PASS  %-4s %s\n' "$method" "$url"
  else
    failed=$((failed + 1))
    printf 'FAIL  %-4s %s\n        %s\n' "$method" "$url" "$reason"
  fi
}

check_base() {
  local base="${1%/}"
  echo "--- $base"
  check GET  "$base/"
  check GET  "$base/onchain"
  check GET  "$base/verify"
  check GET  "$base/api/onchain?subject=$SUBJECT" "tombstone"
  check GET  "$base/api/kyc/status"
  check POST "$base/api/screen" "decision"
}

if [ "$#" -gt 0 ]; then
  targets=("$@")
else
  targets=("${BASE_URLS[@]}")
fi

# The same base URL is checked once even if it is named twice, which matters when the stable
# alias and the custom domain are the same host.
seen=""
count=0
for base in "${targets[@]}"; do
  key="${base%/}"
  case "$seen" in
    *"|$key|"*) continue ;;
  esac
  seen="$seen|$key|"
  count=$((count + 1))
  check_base "$key"
done

if [ "$count" -eq 0 ]; then
  echo "no base URLs to check" >&2
  exit 2
fi

echo
echo "result: $passed ok, $failed failed, across $count base URL(s)"
[ "$failed" -eq 0 ] || exit 1
