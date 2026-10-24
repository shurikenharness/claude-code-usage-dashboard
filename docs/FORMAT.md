# Report format, encryption and upload

What the scripts produce, byte by byte. The dashboard page at
https://shuriken.sh/tools/claude-code-usage-dashboard reads exactly this; a change to any of it
is a new version (the `#v` row, or the envelope's version byte).

## Report format (v1)

UTF-8 text, one row per line, tab-separated, `\n` line ends. Every line must match one of these,
or the dashboard refuses the whole report. Times are UTC.

| Row | Fields |
| --- | --- |
| `#v` | `1` |
| `#meta` | `generated=<unix s>` `tz=<±hhmm>` `script=<sh\|ps1>-<x.y.z>` `files=<n>` `first=<unix s>` `last=<unix s>` `truncated_sessions=<n>` |
| `M` | index, model id (sorted, byte order) |
| `H` | hour (unix s ÷ 3600), model index, effort (0 none, 1 low, 2 medium, 3 high, 4 xhigh, 5 max, 6 ultracode), flags (1 fast, 2 subagent, 4 US-only), calls, input, output, cache read, cache write, 1-hour cache write, web searches |
| `S` | project number, start, end, active seconds (gaps of 15 minutes or less, plus 60 s a call), calls, subagent calls, top model index, tokens (input + output + cache read + cache write), working ms, limit hits |
| `L` | hour, kind (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`, `throttle`), count |

Order: `#v`, `#meta`, `M` by index, `H` by hour, model, effort and flags, `S` by start (the newest
20,000 sessions; the rest are counted in `truncated_sessions`), `L` by hour and kind. Project
numbers follow the sessions' ids, so they say nothing about the folders.

## Encryption (envelope v1)

The system `openssl` on macOS is LibreSSL: no AEAD in `enc` and no `kdf`. OpenSSL 3's `enc` refuses
GCM too. So the envelope is AES-256-CBC with an explicit key and IV, then HMAC-SHA256 over
everything before the tag (encrypt-then-MAC). WebCrypto has both, and the browser checks the tag
before it decrypts, so a changed byte never reaches the padding.

- `K`: 32 random bytes. The link's `k` is `K` in base64url without padding (43 characters).
- `EK = HMAC-SHA256(K, "shuriken usage report v1 enc")`, `MK = HMAC-SHA256(K, "shuriken usage report v1 mac")`.
- `IV`: 16 random bytes. `PT`: the report, gzipped. `CT = AES-256-CBC-PKCS7(EK, IV, PT)`.

| Offset | Bytes | Content |
| --- | --- | --- |
| 0 | 4 | `SKUR` |
| 4 | 1 | version `0x01` |
| 5 | 16 | IV |
| 21 | N (≥ 16, N % 16 = 0) | CT |
| 21 + N | 32 | `HMAC-SHA256(MK, bytes 0 … 20 + N)` |

The dashboard page refuses a version it doesn't know. `test/envelope.mjs` is the same check in
Node, and the tests open every upload with it.
A future version changes the version byte and both labels.

report.sh passes `EK` and `IV` to `openssl enc` as `-K`/`-iv` arguments, so for the second the
command runs they are visible to other accounts on the same computer in the process list.

## Upload

`POST /api/public/usage-reports`, `application/octet-stream`, the envelope as the body. A 200 answer
is one line, `ok <id> <delete token> <expiry ISO 8601>`; anything else is
`error <code> <message>`, and the script prints the message. The link the script prints is
`/tools/claude-code-usage-dashboard/report#r=<id>&k=<key>&d=<delete token>` (under `/nl/` when
`LANG`/`LC_ALL` or the Windows culture is Dutch). Everything after `#` stays in the browser.
