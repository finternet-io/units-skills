#!/usr/bin/env bash
# quickstart.sh — first end-to-end UNITS round trip with curl + jq.
#
#   send OTP -> verify OTP -> (create account) -> register token class -> register class config
#   -> mint -> poll status -> get transaction (tokenId) -> search tokens -> proof
#
# Required env:
#   UNITS_BASE_URL         e.g. https://units.sanctum.finternetlab.io   (sandbox; staging runs ~08:00-21:00 IST weekdays)
#   UNITS_DEVELOPER_TOKEN  base64("sa-<client-uuid>:<secret>") issued by Finternet. NEVER commit it.
#   UNITS_EMAIL            email (or E.164 phone) of the account to log in / sign up as.
# Optional env:
#   UNITS_OTP              OTP to use. Sandbox accepts 123456; on production you will be prompted.
#   UNITS_ADDRESS          address for a NEW account (^[a-z0-9._-]+$). Default: qs-<8 hex of email hash>
#   UNITS_NAME             display name for a NEW account (letters and spaces only). Default: "Quickstart User"
#   UNITS_TOKEN_CLASS      class to register. Default: QS<8 hex>-PTS (class names are GLOBAL across tenants)
#
# Requires: bash, curl, jq, shasum or sha256sum, uuidgen (or /proc/sys/kernel/random/uuid, or python3).
# This script never prints the developer token or JWTs.

set -euo pipefail

: "${UNITS_BASE_URL:?set UNITS_BASE_URL}"
: "${UNITS_DEVELOPER_TOKEN:?set UNITS_DEVELOPER_TOKEN}"
: "${UNITS_EMAIL:?set UNITS_EMAIL}"
BASE="${UNITS_BASE_URL%/}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASS_FILE="$HERE/token-classes/acme-pts.fungible.json"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

sha256() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
new_uuid() {
  if command -v uuidgen >/dev/null; then uuidgen | tr 'A-Z' 'a-z'
  elif [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid
  else python3 -c 'import uuid; print(uuid.uuid4())'; fi
}
now_ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '\n== %s\n' "$*" >&2; }

EMAIL_HASH="$(printf '%s' "$UNITS_EMAIL" | tr 'A-Z' 'a-z' | sha256)"
SHORT="${EMAIL_HASH:0:8}"
TOKEN_CLASS="$(printf '%s' "${UNITS_TOKEN_CLASS:-QS${SHORT}-PTS}" | tr 'a-z' 'A-Z')"

# units_call PATH API_ID PAYLOAD_JSON [JWT] [VALUE_FORMAT]
#   Sets globals RESP (response body), HTTP_STATUS and CALL_OK (1/0). Call it directly (NOT in $(...)),
#   otherwise the globals are lost in the subshell.
#   ok = HTTP 2xx AND context.status != "failed". Data lives in .response, errors in .context.error.
units_call() {
  local path="$1" api_id="$2" payload="$3" jwt="${4:-}" vf="${5:-}"
  local body out
  body="$(jq -n \
    --arg id "$api_id" --arg ts "$(now_ts)" --arg msg "$(new_uuid)" \
    --arg dev "$UNITS_DEVELOPER_TOKEN" --arg jwt "$jwt" --arg vf "$vf" \
    --argjson payload "$payload" '
    {context: ({id: $id, version: "1.0", ts: $ts, msgId: $msg, developerToken: $dev}
               + (if $jwt != "" then {authorization: ("Bearer " + $jwt)} else {} end)
               + (if $vf  != "" then {valueFormat: $vf} else {} end)),
     payload: $payload}')"
  out="$(curl -sS -X POST "$BASE$path" -H 'Content-Type: application/json' \
          --data-binary "$body" -w $'\n%{http_code}')" || { HTTP_STATUS=0; CALL_OK=0; RESP='{}'; return 0; }
  HTTP_STATUS="${out##*$'\n'}"
  local resp="${out%$'\n'*}"
  [ -n "$resp" ] || resp='{}'
  local cstatus
  cstatus="$(printf '%s' "$resp" | jq -r '.context.status // empty' 2>/dev/null || true)"
  if [[ "$HTTP_STATUS" =~ ^2 ]] && [ "$cstatus" != "failed" ]; then CALL_OK=1; else CALL_OK=0; fi
  RESP="$resp"
}

# Show a response without secrets (UNITS echoes context; strip developerToken/authorization defensively).
show() { jq 'del(.context.developerToken, .context.authorization)
             | if .response.accessToken then .response.accessToken = "<redacted>" else . end
             | if .response.refreshToken then .response.refreshToken = "<redacted>" else . end'; }

die_on_fail() {
  if [ "$CALL_OK" != 1 ]; then
    echo "FAILED ($1): HTTP $HTTP_STATUS" >&2
    printf '%s' "$2" | jq '.context.error // .' >&2 || printf '%s\n' "$2" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------------------------
log "1. Send OTP to $UNITS_EMAIL (may send a real email/SMS even on sandbox)"
units_call /v1/account/login api.account.login "$(jq -n --arg u "$UNITS_EMAIL" '{username: $u}')"; R="$RESP"
die_on_fail "send OTP" "$R"; printf '%s' "$R" | show

OTP="${UNITS_OTP:-}"
if [ -z "$OTP" ]; then
  case "$BASE" in
    *units.finternetlab.io) read -r -p "Enter the OTP you received: " OTP ;;   # production: no fixed OTP
    *) OTP="123456" ;;                                                           # sandbox fixed OTP
  esac
fi

log "2. Verify OTP"
units_call /v1/account/login api.account.login "$(jq -n --arg u "$UNITS_EMAIL" --arg o "$OTP" '{username: $u, otp: $o}')"; R="$RESP"
die_on_fail "verify OTP" "$R"; printf '%s' "$R" | show
IS_EXISTING="$(printf '%s' "$R" | jq -r '.response.isExisting')"
JWT="$(printf '%s' "$R" | jq -r '.response.accessToken')"

if [ "$IS_EXISTING" != "true" ]; then
  ADDRESS="$(printf '%s' "${UNITS_ADDRESS:-qs-$SHORT}" | tr 'A-Z' 'a-z')"
  NAME="${UNITS_NAME:-Quickstart User}"
  log "3. Create account address=$ADDRESS (the verify-OTP token is an OTP JWT valid only for this call)"
  units_call /v1/account/create api.account.create \
        "$(jq -n --arg a "$ADDRESS" --arg n "$NAME" '{address: $a, name: $n, entityType: "PERSONAL"}')" "$JWT"; R="$RESP"
  die_on_fail "create account" "$R"; printf '%s' "$R" | show
  JWT="$(printf '%s' "$R" | jq -r '.response.accessToken')"
  ADDRESS_HASH="$(printf '%s' "$ADDRESS" | sha256)"
  echo "STORE THESE NOW (cannot be recovered later): address=$ADDRESS addressHash=$ADDRESS_HASH" >&2
else
  log "3. Account exists — skipping signup"
fi

# ---------------------------------------------------------------------------------------------
log "4. Register token class $TOKEN_CLASS (idempotent: get first). Whoever registers OWNS the class."
units_call /v1/tokenclass/get api.tokenclass.get "$(jq -n --arg c "$TOKEN_CLASS" '{tokenClass: $c}')" "$JWT"; R="$RESP"
CLASS_ID="$(printf '%s' "$R" | jq -r '.response.id // empty')"
if [ "$CALL_OK" != 1 ] || [ -z "$CLASS_ID" ]; then
  REG="$(jq --arg c "$TOKEN_CLASS" '.register | .tokenClass = $c' "$CLASS_FILE")"
  units_call /v1/tokenclass/register api.tokenclass.register "$REG" "$JWT"; R="$RESP"
  die_on_fail "tokenclass/register" "$R"; printf '%s' "$R" | show
  CLASS_ID="$(printf '%s' "$R" | jq -r '.response.id')"
else
  echo "class exists: $CLASS_ID (if another tenant owns it, mint will fail FORBIDDEN — set UNITS_TOKEN_CLASS)" >&2
fi

log "5. Bind class to program 'fungible' via tokenclassconfig (without it: primitive_capability_missing)"
units_call /v1/tokenclassconfig/get api.tokenclassconfig.get "$(jq -n --arg c "$TOKEN_CLASS" '{tokenClass: $c}')" "$JWT"; R="$RESP"
if [ "$CALL_OK" != 1 ]; then
  CFG="$(jq --arg c "$TOKEN_CLASS" --arg id "$CLASS_ID" '.config | .tokenClass = $c | .tokenClassId = $id' "$CLASS_FILE")"
  units_call /v1/tokenclassconfig/register api.tokenclassconfig.register "$CFG" "$JWT"; R="$RESP"
  die_on_fail "tokenclassconfig/register" "$R"
fi
printf '%s' "$R" | show

# ---------------------------------------------------------------------------------------------
log "6. Mint 1000.00 points = 100000 base units (decimals 2), valueFormat raw. NO identities[]."
MINT="$(jq -n --arg c "$TOKEN_CLASS" --arg ref "QS-$(date +%s)" '{
  tokenClass: $c,
  initialSupply: "100000",
  metadata: {name: "Quickstart points", tags: {source: "quickstart"}},
  data: {programRef: $ref}
}')"
units_call /v1/token/mint api.token.mint "$MINT" "$JWT" raw; R="$RESP"
die_on_fail "mint" "$R"; printf '%s' "$R" | show
TX_ID="$(printf '%s' "$R" | jq -r '.response.txId')"

log "7. Poll transaction status for $TX_ID (submitted -> ... -> completed|failed|cancelled)"
DELAY=1; DEADLINE=$(( $(date +%s) + 120 )); STATUS=""
while :; do
  units_call /v1/transaction/status api.transaction.status "$(jq -n --arg t "$TX_ID" '{txId: $t}')" "$JWT"; R="$RESP"
  STATUS="$(printf '%s' "$R" | jq -r '.response.status // empty')"
  echo "status=$STATUS" >&2
  case "$STATUS" in submitted|pending|processing|executing|"") ;; *) break ;; esac
  [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "timed out — keep polling later; do NOT re-mint blindly" >&2; exit 1; }
  sleep "$DELAY"; DELAY=$(( DELAY < 8 ? DELAY * 2 : 10 ))
done
printf '%s' "$R" | show
[ "$STATUS" = "completed" ] || { echo "mint ended with status=$STATUS — most validation errors only appear here" >&2; exit 1; }

log "8. Resolve tokenId (mint responses never contain it)"
units_call /v1/transaction/get api.transaction.get "$(jq -n --arg t "$TX_ID" '{txId: $t}')" "$JWT"; R="$RESP"
TOKEN_ID="$(printf '%s' "$R" | jq -r '.response.metadata.token_id // .response.metadata.affectedTokenIds[0] // .response.responseData.tokenId // .response.responseData.id // empty')"
printf '%s' "$R" | show

log "9. Search tokens of class $TOKEN_CLASS (only tokens where you are an identity are returned)"
units_call /v1/token/search api.token.search "$(jq -n --arg c "$TOKEN_CLASS" '{
  filters: {tokenClass: $c}, pagination: {limit: 5, offset: 0}, sortBy: {field: "createdAt", order: "desc"}}')" "$JWT" raw; R="$RESP"
die_on_fail "token/search" "$R"; printf '%s' "$R" | show
[ -n "$TOKEN_ID" ] || TOKEN_ID="$(printf '%s' "$R" | jq -r '.response.tokens[0].id // empty')"
echo "tokenId=$TOKEN_ID" >&2

log "10. Proof for the mint (proofStatus is usually 'pending': Merkle batches close only when full; no chain anchoring)"
units_call /v1/transaction/proof api.transaction.proof "$(jq -n --arg t "$TX_ID" '{txId: $t}')" "$JWT"; R="$RESP"
printf '%s' "$R" | show || true

log "Done. class=$TOKEN_CLASS classId=$CLASS_ID txId=$TX_ID tokenId=$TOKEN_ID"
