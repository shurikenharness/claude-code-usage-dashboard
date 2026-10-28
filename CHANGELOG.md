# Changelog

Every release is a tag `vX.Y.Z` with `report.sh`, `report.ps1` and `SHA256SUMS` attached. The
version is also in each report the scripts send (`script=sh-X.Y.Z`, `script=ps1-X.Y.Z`).

## [1.1.0] - 2026-10-28

Much faster on a big transcript folder; the same report, byte for byte.

- `report.sh` reads the transcripts with perl when the computer has it (macOS and nearly every
  Linux do): one pass over each file, in order, instead of grep and awk. On 1 GB of made-up
  transcripts shaped like a heavy user's (scripts/bench-data.mjs) on an Apple silicon Mac, a dry
  run went from 49 s to 4 s. Without perl it runs the grep and awk pass of 1.0.0, unchanged; the
  tests check both give the golden report.
- With `--days N`, files last written more than a day before those days began are skipped: a
  transcript is only appended to, so they hold none of the rows.
- In a terminal, it shows how much of the folder it has read.
- `report.ps1`: only the version changes.

## [1.0.0] - 2026-10-24

First release on GitHub. The scripts were first served from shuriken.sh; this release is the same
code with two comment lines added at the top (where the source lives, and its license). Same
report, same encryption, same upload.

- `report.sh` for macOS and Linux (bash 3.2 or later, plus tools those systems ship with).
- `report.ps1` for Windows PowerShell 5.1 and PowerShell 7, .NET built-ins only.
- Report format v1 and envelope v1 (docs/FORMAT.md).
