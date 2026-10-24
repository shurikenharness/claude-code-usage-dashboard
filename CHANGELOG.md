# Changelog

Every release is a tag `vX.Y.Z` with `report.sh`, `report.ps1` and `SHA256SUMS` attached. The
version is also in each report the scripts send (`script=sh-X.Y.Z`, `script=ps1-X.Y.Z`).

## [1.0.0] - 2026-10-24

First release on GitHub. The scripts were first served from shuriken.sh; this release is the same
code with two comment lines added at the top (where the source lives, and its license). Same
report, same encryption, same upload.

- `report.sh` for macOS and Linux (bash 3.2 or later, plus tools those systems ship with).
- `report.ps1` for Windows PowerShell 5.1 and PowerShell 7, .NET built-ins only.
- Report format v1 and envelope v1 (docs/FORMAT.md).
