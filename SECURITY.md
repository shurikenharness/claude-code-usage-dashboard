# Security

## Reporting a vulnerability

Email [office@shuriken.sh](mailto:office@shuriken.sh). Please don't open a public issue about it.
There is no separate security@ address; office@ is the one that reaches us, and it is also in
[shuriken.sh/.well-known/security.txt](https://shuriken.sh/.well-known/security.txt).

What helps: which file and version (`script=` in a `--dry-run` report), what you found, how to
reproduce it, and what it lets someone do. Test with your own data, and give us time to fix it
before you publish. We reply to every report. The full policy is at
[shuriken.sh/security#report](https://shuriken.sh/security#report).

Most useful to hear about:

- anything the scripts read or send beyond what README.md lists;
- a way to make them upload without encryption, or with a key the server could learn;
- a released file whose SHA-256 doesn't match `SHA256SUMS` or its build attestation.

## Checking a download

Each release has `SHA256SUMS` and a GitHub build attestation for `report.sh` and `report.ps1`:

```sh
gh attestation verify report.sh --repo shurikenharness/claude-code-usage-dashboard
```
