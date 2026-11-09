#!/bin/sh
# PressID protest-day readiness drill (cycle 22).
# Spins a throwaway backend + runs a scripted protest scenario via curl.
# Usage: ./scripts/drill.sh [port]   (default 4100)
# No npm deps: curl + node -e for JSON parsing.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PORT="${1:-4100}"
BASE="http://127.0.0.1:$PORT/api"
DB="/tmp/drill.db"
KEYS="/tmp/drill-keys"
PASS=0
FAIL=0

RED='\033[31m'; GREEN='\033[32m'; RESET='\033[0m'

# Refuse to run against a live server on the port.
if curl -s -m 2 "$BASE/health" >/dev/null 2>&1; then
  echo "drill: port $PORT already live, refusing (pass another port)" >&2
  exit 1
fi

rm -f "$DB" "$DB-wal" "$DB-shm" "$DB-journal"
rm -rf "$KEYS"

# Throwaway backend: fresh DB + keys, dev secret, quiet log.
PRESSID_DB="$DB" PRESSID_KEYS_DIR="$KEYS" ALLOW_DEV_SECRET=1 PRESSID_QUIET=1 PORT="$PORT" \
  node "$ROOT/src/server.js" > /tmp/drill-server.log 2>&1 &
SRV=$!
cleanup() { kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; rm -f "$DB" "$DB-wal" "$DB-shm" "$DB-journal"; rm -rf "$KEYS" /tmp/drill-server.log; }
trap cleanup EXIT INT TERM

# Wait for boot (max ~15 s).
BOOT_START=$(date +%s)
i=0
while ! curl -s -m 2 "$BASE/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 75 ]; then echo "drill: server failed to boot"; sed -n '1,20p' /tmp/drill-server.log; exit 1; fi
  sleep 0.2
done
BOOT_END=$(date +%s)
BOOT_SECS=$((BOOT_END - BOOT_START))
if [ "$BOOT_SECS" -gt 5 ]; then echo "drill: slow boot ${BOOT_SECS}s — machine contention?" >&2; fi

# JSON field extractor: jget '$FILE' 'a.b.0.c'
jget() { node -e "const fs=require('fs');let o;try{o=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))}catch(e){process.exit(1)}const p=process.argv[2].split('.');let v=o;for(const k of p){v=v==null?null:(Array.isArray(v)?v[Number(k)]:v[k])}if(v==null||v===''||v===false&&process.argv[2]==='x'){process.exit(1)}console.log(typeof v==='object'?JSON.stringify(v):String(v))" "$1" "$2"; }
jhas() { node -e "const fs=require('fs');let o;try{o=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))}catch(e){process.exit(1)}const want=process.argv[2];const arr=Array.isArray(o)?o:[...(o.reasons||[]),...(o.alerts||[]),...(o.flags||[])];if(!arr.includes(want)){process.exit(1)}" "$1" "$2"; }

step() { # step <name> <sh-condition...>
  name="$1"; shift
  _t0=$(date +%s)
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); _r=PASS; _c="$GREEN";
  else FAIL=$((FAIL + 1)); _r=FAIL; _c="$RED"; fi
  _t1=$(date +%s); _dt=$((_t1 - _t0))
  if [ "$_dt" -gt 2 ]; then printf '%b%s%b %s (%ss)\n' "$_c" "$_r" "$RESET" "$name" "$_dt";
  else printf '%b%s%b %s\n' "$_c" "$_r" "$RESET" "$name"; fi
}
check4() { jhas /tmp/d.4 EVENT_ACTIVE && node -e "if(!JSON.parse(require('fs').readFileSync('/tmp/d.4','utf8')).valid)process.exit(1)"; }
check5() { node -e "if(!JSON.parse(require('fs').readFileSync('/tmp/d.5','utf8')).valid)process.exit(1)"; }
check7() { jget /tmp/d.7 triage | grep -q acked; }
check8() { node -e "if(!JSON.parse(require('fs').readFileSync('/tmp/d.8','utf8')).ok)process.exit(1)"; }
check9() { jhas /tmp/d.9 CARD_REPORTED && node -e "if(JSON.parse(require('fs').readFileSync('/tmp/d.9','utf8')).valid)process.exit(1)"; }
check10() { node -e "if(!JSON.parse(require('fs').readFileSync('/tmp/d.10','utf8')).ok)process.exit(1)"; }
C() { curl -s -m 5 "$@"; }

# ---- setup (fail fast, uncounted): admin creates issuer + police, issuer creates holder ----
ADMIN_TOK=$(C -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
[ -n "$ADMIN_TOK" ] || { echo "drill: admin login failed"; exit 1; }
# cycle 47: fresh-seeded admin carries must_change=1 — rotate before guarded routes (first-boot runbook).
C -X POST "$BASE/auth/change-password" -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' -d '{"oldPassword":"admin123","newPassword":"rotated-admin-drill1"}' > /dev/null
ADMIN_TOK=$(C -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"rotated-admin-drill1"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
[ -n "$ADMIN_TOK" ] || { echo "drill: admin rotation failed"; exit 1; }
C -X POST "$BASE/users" -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' -d '{"username":"drill-issuer","password":"pass12345","role":"issuer","orgName":"Drill Press"}' > /tmp/d.u
C -X POST "$BASE/users" -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' -d '{"username":"drill-police","password":"pass12345","role":"police","zone":"north"}' > /tmp/d.u2
EVENT_END=$(node -e "console.log(new Date(Date.now()+48*3600000).toISOString())" | tr -d '\r\n ')
ISSUER_TOK=$(C -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"drill-issuer","password":"pass12345"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
POLICE_TOK=$(C -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"drill-police","password":"pass12345"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
HOLDER_RESP=$(C -X POST "$BASE/holders" -H "Authorization: Bearer $ISSUER_TOK" -H 'Content-Type: application/json' -d '{"fullName":"Drill Reporter","org":"Drill Press","designation":"Reporter","idRef":"DRILL-001"}')
echo "$HOLDER_RESP" > /tmp/d.holder
HID=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/d.holder','utf8')).holder.id")
PRESS_USER=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/d.holder','utf8')).username")
PRESS_PASS=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/d.holder','utf8')).tempPassword")

# ---- 1. admin login (rotated creds from setup) ----
C -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"rotated-admin-drill1"}' > /tmp/d.1
step "1 admin login" jget /tmp/d.1 token

# ---- 2. issuer login ----
C -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"drill-issuer","password":"pass12345"}' > /tmp/d.2
step "2 issuer login" jget /tmp/d.2 token

# ---- 3. issue event card ----
C -X POST "$BASE/cards" -H "Authorization: Bearer $ISSUER_TOK" -H 'Content-Type: application/json' -d "{\"holderId\":$HID,\"validDays\":30,\"zones\":\"north\",\"eventName\":\"Demo Bandh\",\"eventEnd\":\"$EVENT_END\"}" > /tmp/d.3
step "3 issue event card" jget /tmp/d.3 token
CTOKEN=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/d.3','utf8')).token" 2>/dev/null || true)
CID=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/d.3','utf8')).card.id" 2>/dev/null || true)
[ -n "${CTOKEN:-}" ] && [ -n "${CID:-}" ] || { echo "drill: issue failed:"; cat /tmp/d.3; echo; exit 1; }

# ---- 4. police verify: VALID + EVENT_ACTIVE ----
C -X POST "$BASE/verify" -H "Authorization: Bearer $POLICE_TOK" -H 'Content-Type: application/json' -d "{\"token\":\"$CTOKEN\",\"lat\":28.61,\"lng\":77.23}" > /tmp/d.4
step "4 verify VALID+EVENT_ACTIVE" check4

# ---- 5. far scan (Mumbai, ~1150 km away) ----
C -X POST "$BASE/verify" -H "Authorization: Bearer $POLICE_TOK" -H 'Content-Type: application/json' -d "{\"token\":\"$CTOKEN\",\"lat\":19.07,\"lng\":72.87}" > /tmp/d.5
step "5 far scan logged" check5

# ---- 6. SIMULTANEOUS_FAR flag raised ----
step "6 SIMULTANEOUS_FAR flag" jhas /tmp/d.5 SIMULTANEOUS_FAR

# ---- 7. triage ack (admin) ----
SCAN_ID=$(C "$BASE/scans?cardId=$CID" -H "Authorization: Bearer $ADMIN_TOK" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).find(s=>(s.flags||[]).includes('SIMULTANEOUS_FAR')).id" 2>/dev/null || true)
[ -n "${SCAN_ID:-}" ] || { echo "drill: no flagged scan found"; FAIL=$((FAIL+1)); printf '%bFAIL%b 7 triage ack\n' "$RED" "$RESET"; }
if [ -n "${SCAN_ID:-}" ]; then
  C -X PATCH "$BASE/scans/$SCAN_ID/triage" -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' -d '{"state":"acked"}' > /tmp/d.7
  step "7 triage ack" check7
fi

# ---- 8. press report-loss ----
PRESS_TOK=$(C -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$PRESS_USER\",\"password\":\"$PRESS_PASS\"}" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
# cycle 24: mustChange press rotates before /me/* unlocks
C -X POST "$BASE/auth/change-password" -H "Authorization: Bearer $PRESS_TOK" -H 'Content-Type: application/json' -d "{\"oldPassword\":\"$PRESS_PASS\",\"newPassword\":\"rotated-drill-pw1\"}" > /tmp/d.pw
C -X POST "$BASE/me/report-loss" -H "Authorization: Bearer $PRESS_TOK" -H 'Content-Type: application/json' -d "{\"cardId\":$CID}" > /tmp/d.8
step "8 press report-loss" check8

# ---- 9. verify now CARD_REPORTED ----
C -X POST "$BASE/verify" -H "Authorization: Bearer $POLICE_TOK" -H 'Content-Type: application/json' -d "{\"token\":\"$CTOKEN\",\"lat\":28.61,\"lng\":77.23}" > /tmp/d.9
step "9 verify CARD_REPORTED" check9

# ---- 10. audit chain verifies ----
C "$BASE/audit/verify" -H "Authorization: Bearer $ADMIN_TOK" > /tmp/d.10
step "10 audit/verify ok" check10

rm -f /tmp/d.1 /tmp/d.2 /tmp/d.3 /tmp/d.4 /tmp/d.5 /tmp/d.7 /tmp/d.8 /tmp/d.9 /tmp/d.10 /tmp/d.u /tmp/d.u2 /tmp/d.holder /tmp/d.pw
echo "drill: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
