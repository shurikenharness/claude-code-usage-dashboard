// Prints the one-line commands for this version, each pinned to the release's files and their
// SHA-256, as Markdown for the release notes. Run: node scripts/commands.mjs [--notes]
// The site (shuriken.sh/tools/claude-code-usage-dashboard) shows the same two commands.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = "shurikenharness/claude-code-usage-dashboard";
const root = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const tag = `v${version}`;
const sha = (file) => createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
const url = (file) => `https://github.com/${REPO}/releases/download/${tag}/${file}`;

export const commands = {
  sh: `curl -fsSLo report.sh ${url("report.sh")} && openssl dgst -sha256 -r report.sh | grep -q ^${sha("report.sh")} && bash report.sh`,
  ps1: `irm "${url("report.ps1")}" -OutFile report.ps1; if ((Get-FileHash report.ps1).Hash -eq '${sha("report.ps1")}') { & ([scriptblock]::Create((Get-Content report.ps1 -Raw))) } else { 'report.ps1 does not match its SHA-256, so it was not run.' }`,
};

if (process.argv.includes("--notes")) {
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const section = changelog.split(/^## /m).find((part) => part.startsWith(`[${version}]`) || part.startsWith(version)) ?? "";
  const changes = section.split("\n").slice(1).join("\n").trim();
  process.stdout.write(`${changes}

## Run it

macOS and Linux (downloads report.sh, checks its SHA-256, then runs it):

\`\`\`sh
${commands.sh}
\`\`\`

Windows PowerShell:

\`\`\`powershell
${commands.ps1}
\`\`\`

## Checksums (SHA-256)

\`\`\`
${sha("report.sh")}  report.sh
${sha("report.ps1")}  report.ps1
\`\`\`

These files are also signed with a GitHub build attestation:
\`gh attestation verify report.sh --repo ${REPO}\`
`);
} else {
  process.stdout.write(`${commands.sh}\n\n${commands.ps1}\n`);
}
