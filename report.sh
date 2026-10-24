#!/usr/bin/env bash
# See your Claude Code usage, by Shuriken: https://shuriken.sh/tools/claude-code-usage-dashboard
# Source, releases and checksums: https://github.com/shurikenharness/claude-code-usage-dashboard
# SPDX-License-Identifier: MIT
#
# What this script does, in order:
#   1. Finds your Claude Code transcripts: the folders you name with --dir, else the ones in
#      CLAUDE_CONFIG_DIR, else ~/.claude and ~/.config/claude.
#   2. Reads numbers from them: model names, token counts, times, effort levels and limit hits.
#      It never reads your prompts, Claude's replies, file paths or project names.
#   3. Shows you a summary and asks before anything leaves this computer.
#   4. Encrypts the report here with a new random key and uploads only the encrypted bytes.
#   5. Prints your private link. The key sits after the "#", and browsers never send that part.
#
# Options: --dir PATH (repeat it for more folders), --days N (only the last N days),
#          --dry-run (print what would be sent and send nothing), --yes (don't ask), --help
# Needs only what macOS and Linux ship: bash, find, grep, awk, sort, gzip, od, openssl, curl.
# What each part does: https://shuriken.sh/tools/claude-code-usage-dashboard/script
set -euo pipefail
umask 077

SCRIPT=sh-1.0.0
ORIGIN="${SHURIKEN_REPORT_ORIGIN:-https://shuriken.sh}"  # tests point this at a local server
TOOL=/tools/claude-code-usage-dashboard
T="$(printf '\t')"

say() { printf '%s\n' "$*" >&2; }
die() { say "Error: $*"; exit 1; }

# extract.awk: one pass over the matching transcript lines. It looks only at fixed keys and
# prints them as rows: T (a model call), L (a limit hit), D (Claude's working time for a turn),
# P (an effort level was set), C (which project a session belongs to, as a number).
EXTRACT='
function val(s, key,   i, v) { i = index(s, key); if (!i) return ""
  v = substr(s, i + length(key), 256); i = index(v, "\""); return i ? substr(v, 1, i - 1) : "" }
function num(s, key,   i) { i = index(s, key); if (!i) return 0
  if (!match(substr(s, i + length(key), 24), /^[0-9]+/)) return 0
  return substr(s, i + length(key), RLENGTH) }   # kept as digits: old mawk prints big numbers as 3e+09
function last(s, key,   i, r) { r = ""; while ((i = index(s, key)) > 0) { s = substr(s, i + length(key)); r = s }
  i = index(r, "\""); return i ? substr(r, 1, i - 1) : "" }
function epoch(t,   y, m, d, o, z) {   # ISO 8601 time to seconds since 1970 (UTC)
  if (t !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) return -1
  y = substr(t, 1, 4) + 0; m = substr(t, 6, 2) + 0; d = substr(t, 9, 2) + 0
  z = substr(t, 20); sub(/^\.[0-9]*/, "", z); o = 0
  if (z ~ /^[+-][0-9][0-9]:?[0-9][0-9]$/) { gsub(/:/, "", z)
    o = (substr(z, 2, 2) * 3600 + substr(z, 4, 2) * 60) * (substr(z, 1, 1) == "-" ? -1 : 1) }
  else if (z != "Z") return -1
  if (m <= 2) { y--; m += 12 }
  d = 365 * y + int(y / 4) - int(y / 100) + int(y / 400) + int((153 * (m - 3) + 2) / 5) + d - 719469
  return d * 86400 + substr(t, 12, 2) * 3600 + substr(t, 15, 2) * 60 + substr(t, 18, 2) - o }
BEGIN { OFS = "\t"; n = split("low medium high xhigh max ultracode", w, " ")
  for (i = 1; i <= n; i++) EFF[w[i]] = i
  split("five_hour seven_day seven_day_opus seven_day_sonnet seven_day_overage_included overage", w, " ")
  for (i in w) KIND[w[i]] = 1 }
{ line = $0; sub(/\r$/, "", line)
  p = index(line, "\"message\":{"); pre = p ? substr(line, 1, p - 1) : line
  sid = tolower(val(pre, "\"sessionId\":\""))
  if (length(sid) != 36 || sid !~ /^[0-9a-f-]+$/) next
  # Effort marks: the /effort command (its one argument word), or an effort field on the row.
  lv = ""
  if (index(line, "<command-name>/effort</command-name>")) { lv = val(line, "<command-args>"); sub(/<.*/, "", lv) }
  else if (index(line, "\"ultracode\":true")) lv = "ultracode"
  else if (index(line, "\"effortLevel\":\"")) lv = val(line, "\"effortLevel\":\"")
  else if (index(line, "\"thinkingMetadata\":{")) lv = val(substr(line, index(line, "\"thinkingMetadata\":{")), "\"level\":\"")
  gsub(/[ \t]/, "", lv); lv = tolower(lv)
  if (lv in EFF) { ts = epoch(last(line, "\"timestamp\":\"")); if (ts >= since) print "P", sid, ts, EFF[lv] }
  if (index(line, "\"subtype\":\"turn_duration\"")) {
    ts = epoch(last(line, "\"timestamp\":\"")); u = last(line, "\"uuid\":\"")
    if (ts >= since && (u == "" || !(u in SEEN))) { SEEN[u] = 1; print "D", sid, ts, num(line, "\"durationMs\":") + 0 }
    next }
  if (!p) next
  # The usage object: the last "usage":{ in the row (it follows the message text). Only that
  # object, which holds numbers and short words, is read.
  r = substr(line, p); q = 0; o = 0
  while ((i = index(r, "\"usage\":{")) > 0) { q = o + i; o += i; r = substr(r, i + 1) }
  if (!q) next
  u = substr(line, p + q + 7); n = length(u); dep = 0
  for (j = 1; j <= n; j++) { c = substr(u, j, 1); if (c == "{") dep++; else if (c == "}" && --dep == 0) break }
  tail = substr(u, j + 1); u = substr(u, 1, j)
  # The row type: before the message in some rows, after it in assistant rows the CLI writes.
  ty = val(pre, "\"type\":\""); if (ty == "") ty = last(tail, "\"type\":\""); if (ty != "assistant") next
  ts = epoch(last(tail, "\"timestamp\":\"")); if (ts < since) next
  if (index(tail, "\"isApiErrorMessage\":true") && index(tail, "\"error\":\"rate_limit\"")) {
    k = val(tail, "\"rateLimitType\":\""); if (!(k in KIND)) k = "throttle"
    id = last(tail, "\"uuid\":\""); if (id == "" || !(id in SEEN)) { SEEN[id] = 1; print "L", sid, ts, k }
    next }
  # message.id and message.model come before its content; the input of a tool call never counts.
  head = substr(line, p, 600); i = index(head, "\"content\":"); if (i) head = substr(head, 1, i - 1)
  model = tolower(val(head, "\"model\":\""))
  if (model == "<synthetic>") next
  if (length(model) > 64 || model !~ /^[a-z0-9][a-z0-9._-]*$/) model = "other"
  cwd = val(pre, "\"cwd\":\""); if (!(cwd in PROJ)) PROJ[cwd] = np++
  if (!(sid in PJ)) PJ[sid] = PROJ[cwd]
  cw = num(u, "\"cache_creation_input_tokens\":"); c1 = num(u, "\"ephemeral_1h_input_tokens\":"); if (c1 + 0 > cw + 0) c1 = cw
  v = sid OFS ts OFS model OFS num(u, "\"input_tokens\":") OFS num(u, "\"output_tokens\":") OFS \
      num(u, "\"cache_read_input_tokens\":") OFS cw OFS c1 OFS num(u, "\"web_search_requests\":") OFS \
      (index(u, "\"speed\":\"fast\"") > 0) OFS (index(pre, "\"isSidechain\":true") > 0) OFS (index(u, "\"inference_geo\":\"us\"") > 0)
  # One API request is written as several rows; the copy with the largest counts wins.
  mid = val(head, "\"id\":\""); rid = last(tail, "\"requestId\":\"")
  key = (mid != "" && rid != "") ? mid ":" rid : "#" NR
  if (!(key in V)) { V[key] = v; next }
  split(V[key], a, "\t"); split(v, b, "\t")
  if (b[2] + 0 < a[2] + 0 || (b[2] + 0 == a[2] + 0 && b[1] < a[1])) { a[1] = b[1]; a[2] = b[2] }
  for (i = 4; i <= 12; i++) if (b[i] + 0 > a[i] + 0) a[i] = b[i]
  V[key] = a[1]; for (i = 2; i <= 12; i++) V[key] = V[key] OFS a[i] }
END { for (k in V) print "T", V[k]; for (s in PJ) print "C", s, 0, PJ[s] }'

# reduce.awk: walks the rows of each session in time order and adds them up into the report.
# First input: the model names, one per line, sorted; their line number is their index.
REDUCE='
function flush(   m, top) { if (cur == "" || !calls) return
  if (!(proj in PN)) PN[proj] = np++
  top = 0; for (m = 0; m < nm; m++) if (SM[m] > SM[top]) top = m
  printf "S\t%d\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%d\t%.0f\t%.0f\t%.0f\n", PN[proj], start, end, act, calls, side, top, tok, worked, hits }
BEGIN { FS = OFS = "\t" }
FNR == NR { MI[$1] = nm + 0; print "M", nm++ + 0, $1; next }
$2 != cur { flush(); cur = $2; proj = 0; eff = 0; calls = side = tok = worked = hits = act = 0; split("", SM) }
$1 == "C" { proj = $4; next }
$1 == "P" { eff = $4; next }
$1 == "D" { worked += $4; next }
$1 == "L" { L[int($3 / 3600) OFS $4]++; hits++; next }
$1 == "T" { m = MI[$4]; f = $11 + 2 * $12 + 4 * $13; k = int($3 / 3600) OFS m OFS eff OFS f
  HT[k]++; HI[k] += $5; HO[k] += $6; HR[k] += $7; HW[k] += $8; H1[k] += $9; HS[k] += $10
  if (!calls) start = $3; else if ($3 - end <= 900) act += $3 - end
  end = $3; act += 60; calls++; side += $12; SM[m]++; tok += $5 + $6 + $7 + $8
  if (!first || $3 < first) first = $3; if ($3 > lastt) lastt = $3 }
END { flush(); printf "%.0f\t%.0f\n", first, lastt > range
  for (k in HT) printf "H\t%s\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\n", k, HT[k], HI[k], HO[k], HR[k], HW[k], H1[k], HS[k]
  for (k in L) print "L", k, L[k] }'

usage() {
  cat >&2 <<'HELP'
Makes a private dashboard of your Claude Code usage: https://shuriken.sh/tools/claude-code-usage-dashboard
  --dir PATH   read this folder (a Claude Code config folder or its projects folder); repeatable
  --days N     only the last N days
  --dry-run    print the whole report that would be sent, send nothing
  --yes        send without asking
HELP
}

main() {
  local dry=0 yes=0 days=0 dirs="" d
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) [ $# -ge 2 ] || die "--dir needs a folder."; dirs="$dirs$2"$'\n'; shift 2 ;;
      --days) [[ "${2:-}" =~ ^[0-9]+$ ]] || die "--days needs a number of days."; days=$2; shift 2 ;;
      --dry-run) dry=1; shift ;;
      --yes|-y) yes=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "Unknown option $1. Try --help." ;;
    esac
  done
  case "$ORIGIN" in https://*|http://127.0.0.1:*) ;; *) die "SHURIKEN_REPORT_ORIGIN must start with https://." ;; esac

  local need="find grep awk sort gzip od tr wc date mktemp" missing="" t
  [ $dry = 1 ] || need="$need openssl curl"
  for t in $need; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
  [ -z "$missing" ] || die "this computer is missing:$missing. Install them and run the command again."

  # Where Claude Code keeps its transcripts: <config folder>/projects/<project>/<session>.jsonl.
  if [ -z "$dirs" ]; then
    if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then dirs="$(printf '%s\n' "$CLAUDE_CONFIG_DIR" | tr ',' '\n')"$'\n'
    else dirs="$HOME/.claude"$'\n'"$HOME/.config/claude"$'\n'; fi
  fi
  set --
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ -d "$d/projects" ]; then set -- "$@" "$d/projects"; elif [ -d "$d" ]; then set -- "$@" "$d"; fi
  done <<< "$dirs"
  [ $# -gt 0 ] || die "No Claude Code data found. Looked in: $(printf '%s' "$dirs" | tr '\n' ' ')Use --dir to point at the folder."

  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  local files bytes
  files=$( { find "$@" -type f -name '*.jsonl' || true; } | wc -l | tr -d ' ')
  [ "$files" -gt 0 ] || die "No Claude Code data found in $*. Use --dir to point at the folder."
  bytes=$( { find "$@" -type f -name '*.jsonl' -exec wc -c {} + || true; } | awk '!(NF == 2 && $2 == "total") { s += $1 } END { printf "%.0f", s }')
  say "Reading $files transcript files ($(awk -v b="$bytes" 'BEGIN { printf "%.1f MB", b / 1048576 }'))..."

  # 1. Pick out only the lines that can hold usage, limits, turn times or effort, then extract.
  local now since=0
  now=$(date +%s); [ "$days" = 0 ] || since=$((now - days * 86400))
  { LC_ALL=C find "$@" -type f -name '*.jsonl' -exec grep -h -F -e '"type":"assistant"' -e '"subtype":"turn_duration"' \
      -e 'command-name>/effort<' -e '"effortLevel"' -e '"ultracode":true' -e '"thinkingMetadata"' {} + || true; } |
    LC_ALL=C awk -v since="$since" "$EXTRACT" > "$TMP/rows"
  LC_ALL=C awk -F "$T" '$1 == "T" { print $4 }' "$TMP/rows" | LC_ALL=C sort -u > "$TMP/models"
  [ -s "$TMP/models" ] || die "No Claude Code usage found in $files files. Use --dir to point at another folder."

  # 2. Add it up per session and per hour, in a fixed order so the same data gives the same file.
  LC_ALL=C sort -t "$T" -k2,2 -k3,3n -k1,1 "$TMP/rows" |
    LC_ALL=C awk -v range="$TMP/range" "$REDUCE" "$TMP/models" - > "$TMP/body"
  local first last sessions kept truncated=0
  read -r first last < "$TMP/range"
  sessions=$(awk -F "$T" '$1 == "S"' "$TMP/body" | wc -l | tr -d ' ')
  kept=$sessions; [ "$sessions" -le 20000 ] || { kept=20000; truncated=$((sessions - 20000)); }
  {
    printf '#v\t1\n'
    printf '#meta\tgenerated=%s\ttz=%s\tscript=%s\tfiles=%s\tfirst=%s\tlast=%s\ttruncated_sessions=%s\n' \
      "$now" "$(date +%z)" "$SCRIPT" "$files" "$first" "$last" "$truncated"
    awk -F "$T" '$1 == "M"' "$TMP/body"
    awk -F "$T" '$1 == "H"' "$TMP/body" | LC_ALL=C sort -t "$T" -k2,2n -k3,3n -k4,4n -k5,5n
    awk -F "$T" '$1 == "S"' "$TMP/body" | LC_ALL=C sort -t "$T" -k3,3n -k1 | tail -n "$kept"
    awk -F "$T" '$1 == "L"' "$TMP/body" | LC_ALL=C sort -t "$T" -k2,2n -k3,3
  } > "$TMP/report.tsv"

  local calls projects
  calls=$(awk -F "$T" '$1 == "S" { s += $6 } END { printf "%.0f", s }' "$TMP/report.tsv")
  projects=$(awk -F "$T" '$1 == "S" { p[$2] = 1 } END { for (k in p) n++; print n + 0 }' "$TMP/report.tsv")
  gzip -9 -n < "$TMP/report.tsv" > "$TMP/report.gz"
  [ "$(wc -c < "$TMP/report.gz")" -le 1400000 ] || die "The report is too large to upload. Try --days 90."
  say "Found $kept sessions in $projects projects: $calls model calls."
  say "Sends: counts per hour, model names, token totals, effort levels, session lengths and limit-hit times ($(( $(wc -c < "$TMP/report.gz") / 1024 + 1 )) KB, encrypted here first)."
  say "Never sends: your prompts, Claude's replies, file paths or project names."
  if [ $dry = 1 ]; then say "Dry run: this is the whole report, before encryption. Nothing was sent."; cat "$TMP/report.tsv"; exit 0; fi
  if [ $yes = 0 ]; then
    { : < /dev/tty; } 2>/dev/null || die "Can't ask for confirmation here. Run it again with --yes to send."
    printf 'Continue? [Y/n] ' >&2; read -r d < /dev/tty || d=n
    case "$d" in ""|y|Y|yes|Yes|j|J|ja) ;; *) say "Nothing was sent."; exit 0 ;; esac
  fi

  # 3. Encrypt (AES-256-CBC, then HMAC-SHA256 over everything before the tag). Two keys are
  #    derived from one random key K, and K goes only into your link.
  hex() { od -An -tx1 | tr -d ' \n'; }
  openssl rand 32 > "$TMP/k"; openssl rand 16 > "$TMP/iv"
  local K EK MK
  K=$(hex < "$TMP/k")
  EK=$(printf '%s' "shuriken usage report v1 enc" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$K" -binary | hex)
  MK=$(printf '%s' "shuriken usage report v1 mac" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$K" -binary | hex)
  openssl enc -aes-256-cbc -K "$EK" -iv "$(hex < "$TMP/iv")" -in "$TMP/report.gz" -out "$TMP/ct"
  { printf 'SKUR\001'; cat "$TMP/iv" "$TMP/ct"; } > "$TMP/env"
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:$MK" -binary < "$TMP/env" >> "$TMP/env"
  local key; key=$(openssl base64 -A < "$TMP/k" | tr '+/' '-_' | tr -d '=')

  # 4. Upload the encrypted bytes. The answer is: ok <id> <delete token> <expiry>.
  local proto="=https" code answer id del expires
  case "$ORIGIN" in http://*) proto="=http" ;; esac
  code=$(curl -sS --proto "$proto" --tlsv1.2 -X POST -H 'Content-Type: application/octet-stream' \
    --data-binary @"$TMP/env" -o "$TMP/answer" -w '%{http_code}' "$ORIGIN/api/public/usage-reports") ||
    die "Couldn't reach $ORIGIN. Check your internet connection and run the command again."
  answer=$(head -c 300 "$TMP/answer" | tr -d '\r')
  [ "$code" = 200 ] || die "The upload was refused ($code): ${answer#error * }"
  read -r ok id del expires <<< "$answer"
  [[ "$ok" = ok && "$id" =~ ^[A-Za-z0-9_-]+$ && "$del" =~ ^[A-Za-z0-9_-]+$ ]] || die "Unexpected answer from $ORIGIN."
  local lang=""; case "${LC_ALL:-${LANG:-}}" in nl*) lang=/nl ;; esac
  printf '\nYour report: %s%s%s/report#r=%s&k=%s&d=%s\n' "$ORIGIN" "$lang" "$TOOL" "$id" "$key" "$del"
  printf 'Only you can see this. We can'"'"'t read it: the key never leaves your link.\n'
  printf 'Anyone with this link can open the report. It is deleted on %s.\n' "${expires%%T*}"
}

main "$@"
