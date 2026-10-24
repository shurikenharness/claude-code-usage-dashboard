// report.ps1 against the same made-up transcripts as report.sh: the same report, byte for byte,
// and an upload test/envelope.mjs opens. Runs under every PowerShell this machine has: `pwsh`
// (PowerShell 7) and, on Windows, `powershell` (Windows PowerShell 5.1). POWERSHELL=<command>
// picks one by hand. With none, these tests are skipped (CI runs them on Linux, macOS and Windows).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { openEnvelope, readFragment } from "./envelope.mjs";
import { CANARY, EXPECTED, writeFixtureTranscripts } from "./fixtures/transcripts.mjs";
import { closedPort, DELETE_TOKEN, parseReport, REPORT_ID, steady, stubServer, sum } from "./helpers.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "../report.ps1");
const GOLDEN = readFileSync(path.resolve(import.meta.dirname, "fixtures/golden.tsv"), "utf8");
const ROOT = mkdtempSync(path.join(tmpdir(), "usage-report-ps1-"));
const CONFIG = path.join(ROOT, "home", ".claude");
const EMPTY = path.join(ROOT, "empty");

const works = (command) =>
  spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).status === 0;
const SHELLS = process.env.POWERSHELL
  ? [process.env.POWERSHELL]
  : [process.platform === "win32" ? "powershell" : null, "pwsh"].filter((command) => command && works(command));

/** Runs report.ps1 as a file (`-File`), or as a script block, the way the one-line command does. */
function run(shell, args, { env = {}, block = false } = {}) {
  const quoted = args.map((arg) => (arg.startsWith("-") ? arg : `'${arg.replaceAll("'", "''")}'`)).join(" ");
  const how = block
    ? ["-Command", `& ([scriptblock]::Create((Get-Content -LiteralPath '${SCRIPT}' -Raw))) ${quoted}`]
    : ["-File", SCRIPT, ...args];
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE_|ANTHROPIC_|SHURIKEN_)/.test(key)));
    const child = spawn(shell, ["-NoProfile", "-NonInteractive", ...how], {
      env: { ...clean, LANG: "en_US.UTF-8", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let stub;
before(async () => {
  writeFixtureTranscripts(CONFIG);
  mkdirSync(EMPTY, { recursive: true });
  stub = await stubServer();
});
after(async () => {
  await stub.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("report.ps1", { skip: SHELLS.length ? false : "no PowerShell on this machine" }, () => {
  for (const shell of SHELLS) {
    describe(`under ${shell}`, () => {
      it("prints the same report as report.sh, byte for byte (-DryRun)", async () => {
        const dry = await run(shell, ["-DryRun", "-Dir", CONFIG]);
        assert.equal(dry.code, 0, dry.stderr);
        assert.equal(steady(dry.stdout), GOLDEN);
        const report = parseReport(dry.stdout);
        assert.match(report.meta.script, /^ps1-/);
        assert.equal(sum(report.hours, "turns"), EXPECTED.calls);
        assert.ok(!dry.stdout.includes(CANARY));
        assert.ok(dry.stderr.includes("Nothing was sent."));
      });

      it("runs as a script block too, the way the one-line command runs it", async () => {
        const dry = await run(shell, ["-DryRun", "-Dir", CONFIG], { block: true });
        assert.equal(dry.code, 0, dry.stderr);
        assert.equal(steady(dry.stdout), GOLDEN);
      });

      it("uploads an envelope the page opens, and prints the private link", async () => {
        stub.answer = { status: 200, body: `ok ${REPORT_ID} ${DELETE_TOKEN} 2026-11-22T10:00:00Z\n` };
        stub.uploads.length = 0;
        const sent = await run(shell, ["-Yes", "-Dir", CONFIG], { env: { SHURIKEN_REPORT_ORIGIN: stub.origin } });
        assert.equal(sent.code, 0, sent.stderr);
        assert.equal(stub.uploads.length, 1);
        const link = sent.stdout.match(/https?:\/\/\S+/)?.[0] ?? "";
        assert.ok(link.includes("/tools/claude-code-usage-dashboard/report#"), link);
        const fragment = readFragment(new URL(link).hash);
        assert.equal(fragment.report, REPORT_ID);
        assert.equal(fragment.deleteToken, DELETE_TOKEN);
        assert.ok(!stub.uploads[0].toString("latin1").includes(fragment.key));
        const opened = openEnvelope(stub.uploads[0], fragment.key);
        assert.equal(opened.ok, true, opened.reason);
        assert.equal(steady(opened.text), GOLDEN);
        assert.ok(sent.stdout.includes("It is deleted on 2026-11-22."));
      });

      it("passes on the server's refusal in one line", async () => {
        stub.answer = { status: 429, body: "error busy Too many reports from this address. Try again in an hour.\n" };
        const result = await run(shell, ["-Yes", "-Dir", CONFIG], { env: { SHURIKEN_REPORT_ORIGIN: stub.origin } });
        assert.equal(result.code, 1);
        assert.ok(result.stderr.includes("The upload was refused (429): Too many reports from this address. Try again in an hour."), result.stderr);
      });

      it("says so when the server can't be reached, or the origin is plain http elsewhere", async () => {
        const down = await run(shell, ["-Yes", "-Dir", CONFIG], { env: { SHURIKEN_REPORT_ORIGIN: `http://127.0.0.1:${await closedPort()}` } });
        assert.equal(down.code, 1);
        assert.ok(down.stderr.includes("Couldn't reach"), down.stderr);
        const plain = await run(shell, ["-Yes", "-Dir", CONFIG], { env: { SHURIKEN_REPORT_ORIGIN: "http://example.com" } });
        assert.equal(plain.code, 1);
        assert.ok(plain.stderr.includes("must start with https://"), plain.stderr);
      });

      it("says where it looked when there is no Claude Code data", async () => {
        const result = await run(shell, ["-DryRun", "-Dir", EMPTY]);
        assert.equal(result.code, 1);
        assert.ok(result.stderr.includes("No Claude Code data found"), result.stderr);
      });
    });
  }
});
