# Claude Code usage dashboard: the collector

The two scripts behind [shuriken.sh/tools/claude-code-usage-dashboard](https://shuriken.sh/tools/claude-code-usage-dashboard).
You run one on your own computer. It reads the transcripts Claude Code keeps in `~/.claude/projects`,
keeps only numbers (model names, token counts, times, effort levels, limit hits), shows you what it
found, and asks before anything is sent. Then it encrypts the report there, uploads only the
encrypted bytes, and prints a private link. The key is in that link, after the `#`, which browsers
never send to a server. So the server stores a file it can't open, and deletes it after 30 days.

- `report.sh`: macOS and Linux. bash 3.2 or later, plus find, grep, awk, sort, gzip, od, openssl
  and curl, which those systems ship with.
- `report.ps1`: Windows PowerShell 5.1 and PowerShell 7. Only what Windows has built in.

Both print the same report, byte for byte, for the same transcripts. The tests check that on Linux,
macOS and Windows.

## Run it

Each command downloads one file from this repository's v1.0.0 release, checks its SHA-256, and runs
it only when the checksum matches.

macOS and Linux:

```sh
curl -fsSLo report.sh https://github.com/shurikenharness/claude-code-usage-dashboard/releases/download/v1.0.0/report.sh && openssl dgst -sha256 -r report.sh | grep -q ^ca067721b9ec87078e6a72d1f9b6d3b351184fce9b958947d992acc633e9aa2c && bash report.sh
```

Windows (PowerShell):

```powershell
irm "https://github.com/shurikenharness/claude-code-usage-dashboard/releases/download/v1.0.0/report.ps1" -OutFile report.ps1; if ((Get-FileHash report.ps1).Hash -eq 'e1e6203b000a09a7111069783b17f0c2166ddf5a06bc9408dc2f5a0e8ffdc1a3') { & ([scriptblock]::Create((Get-Content report.ps1 -Raw))) } else { 'report.ps1 does not match its SHA-256, so it was not run.' }
```

Newer releases print their own commands in the [release notes](https://github.com/shurikenharness/claude-code-usage-dashboard/releases).

### Read it first

```sh
curl -fsSLo report.sh https://github.com/shurikenharness/claude-code-usage-dashboard/releases/download/v1.0.0/report.sh
openssl dgst -sha256 -r report.sh      # ca067721b9ec87078e6a72d1f9b6d3b351184fce9b958947d992acc633e9aa2c
less report.sh
bash report.sh --dry-run               # prints the whole report it would send, sends nothing
bash report.sh
```

```powershell
irm "https://github.com/shurikenharness/claude-code-usage-dashboard/releases/download/v1.0.0/report.ps1" -OutFile report.ps1
Get-FileHash report.ps1                # e1e6203b000a09a7111069783b17f0c2166ddf5a06bc9408dc2f5a0e8ffdc1a3
notepad report.ps1
& ([scriptblock]::Create((Get-Content report.ps1 -Raw))) -DryRun
& ([scriptblock]::Create((Get-Content report.ps1 -Raw)))
```

The script block form is on purpose: Windows' default execution policy refuses to run an unsigned
`.ps1` you downloaded, and the usual way around that (`-ExecutionPolicy Bypass`) is a line
ad blockers rightly refuse to copy.

### Options

| report.sh | report.ps1 | What it does |
| --- | --- | --- |
| `--dir PATH` (repeatable) | `-Dir PATH[,PATH]` | Read this folder: a Claude Code config folder, or its `projects` folder. |
| `--days N` | `-Days N` | Only rows from the last N days. |
| `--dry-run` | `-DryRun` | Print the whole report that would be sent (before encryption), send nothing. |
| `--yes` | `-Yes` | Send without asking. Without it and without a terminal to ask in, report.sh sends nothing. |

Without `--dir`, the scripts read every folder in `CLAUDE_CONFIG_DIR` (comma-separated), else
`~/.claude` and `~/.config/claude` (`%USERPROFILE%\.claude` on Windows).

## What it reads

Transcripts are `<config>/projects/<project>/<session>.jsonl`, and subagents'
`<session>/subagents/agent-<id>.jsonl`. The script first keeps only the lines that hold one of
`"type":"assistant"`, `"subtype":"turn_duration"`, `/effort`, `"effortLevel"`,
`"ultracode":true` or `"thinkingMetadata"`. From those it reads fixed keys:

- **Model calls**: the model id and message id from the first 600 characters of the message,
  before its `"content":` (so a tool call's input is never read for them), and the last
  `"usage":{…}` object: input, output, cache read, cache write, 1-hour cache write, web searches,
  fast mode, US-only inference. One API request written as several rows counts once.
- **Limit hits**: assistant rows with `"error":"rate_limit"`, and which limit it was.
- **Claude's working time**: `durationMs` of `turn_duration` rows.
- **Effort**: the word after `/effort`, or a row's effort field, when it is one of low, medium,
  high, xhigh, max, ultracode.
- **Projects**: the working folder is a key in memory only. It becomes a number (Project A, B, C
  on the dashboard) and is never printed or sent.

## What it never sends

Your prompts, Claude's replies, tool inputs and outputs, file paths, folder or project names,
git branches, settings or credentials. Lines that hold a reply pass through the script, but it
looks only for the fixed keys above and copies none of the text around them, so a word typed in a prompt
(such as "ultracode") is not counted.

`--dry-run` prints every byte of the report before encryption. That is the whole upload, apart
from the encryption.

## How to check it

- **The file you ran is the file in this repo.** Each release has `SHA256SUMS` and a GitHub
  build attestation: `gh attestation verify report.sh --repo shurikenharness/claude-code-usage-dashboard`.
  Releases here are immutable, so a published file and its tag can't be swapped afterwards.
- **The report holds only numbers.** Run it with `--dry-run` and read the output. Every line
  after the first two is `M`, `H`, `S` or `L` followed by digits, model ids and fixed words
  ([docs/FORMAT.md](docs/FORMAT.md)).
- **The server can't read it.** The upload is AES-256-CBC with an HMAC-SHA256 tag
  (encrypt-then-MAC), under keys made from 32 random bytes that only your link carries.
  [docs/FORMAT.md](docs/FORMAT.md) has the byte layout, and `test/envelope.mjs` opens it in under 50
  lines of Node.

One thing to know: report.sh passes the derived key and IV to `openssl enc` as arguments, so for
the moment that command runs, other accounts on the same computer can see them in the process
list. On a computer you share with people you don't trust, use the Windows script or don't run it.

## Develop

```sh
npm test          # Node 22 or later; the PowerShell tests run when pwsh (or powershell) is installed
```

The tests run the scripts against made-up transcripts in `test/fixtures`, never a real home
folder, and compare the report with `test/fixtures/golden.tsv` byte for byte. Uploads go to a
stub server on 127.0.0.1 (`SHURIKEN_REPORT_ORIGIN`, which accepts only `https://` or
`http://127.0.0.1:<port>`).

A release: bump the version in `report.sh` (`SCRIPT=sh-X.Y.Z`), `report.ps1` (`$Version`),
`package.json` and `CHANGELOG.md`, then push a tag `vX.Y.Z`. The release workflow runs the tests
on Linux, macOS and Windows, then publishes the two scripts, `SHA256SUMS`, the attestation and
the pinned commands.

## Security

Found a problem? Email office@shuriken.sh, or see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
