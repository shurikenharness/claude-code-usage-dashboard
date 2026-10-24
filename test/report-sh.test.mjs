// report.sh against made-up transcripts (test/fixtures), never a real home folder: every run gets
// HOME pointed at a temporary folder and no CLAUDE_* or ANTHROPIC_* variables. The upload tests
// post to a stub server on 127.0.0.1 and open what it received with test/envelope.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { openEnvelope, readFragment } from "./envelope.mjs";
import { CANARY, CWD, EXPECTED, SID, writeFixtureTranscripts } from "./fixtures/transcripts.mjs";
import { closedPort, DELETE_TOKEN, parseReport, REPORT_ID, steady, stubServer, sum } from "./helpers.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "../report.sh");
const GOLDEN = path.resolve(import.meta.dirname, "fixtures/golden.tsv");
const skip = process.platform === "win32" ? "report.sh is for macOS and Linux" : false;
const ROOT = mkdtempSync(path.join(tmpdir(), "usage-report-"));
const HOME = path.join(ROOT, "home");
const EMPTY_HOME = path.join(ROOT, "empty-home");
const CONFIG = path.join(HOME, ".claude");
const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** report.sh under the system bash (3.2 on macOS) with no terminal: detached, so no /dev/tty. */
function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [SCRIPT, ...args], {
      env: { PATH, HOME, LANG: "en_US.UTF-8", ...env },
      detached: true,
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
  mkdirSync(EMPTY_HOME, { recursive: true });
  stub = await stubServer();
});
after(async () => {
  await stub.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("report.sh --dry-run", { skip }, () => {
  let dry;
  before(async () => {
    dry = await run(["--dry-run", "--dir", CONFIG]);
  });

  it("adds the fixtures up to the hand-worked totals", () => {
    assert.equal(dry.code, 0, dry.stderr);
    const report = parseReport(dry.stdout);
    assert.deepEqual(report.models, EXPECTED.models);
    assert.equal(report.meta.files, 6);
    assert.equal(report.meta.first, EXPECTED.firstCall);
    assert.equal(report.meta.last, EXPECTED.lastCall);
    assert.equal(report.meta.truncated_sessions, 0);
    assert.match(report.meta.script, /^sh-/);
    assert.equal(sum(report.hours, "turns"), EXPECTED.calls);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "webSearches"]) {
      assert.equal(sum(report.hours, key), EXPECTED[key], key);
    }
    const byEffort = {};
    for (const row of report.hours) byEffort[row.effort] = (byEffort[row.effort] ?? 0) + row.turns;
    assert.deepEqual(byEffort, EXPECTED.effort);
    // Fast + US-only on one call (1 | 4), the subagent's call (2).
    assert.deepEqual(report.hours.filter((row) => row.flags === 5).map((row) => row.turns), [1]);
    assert.deepEqual(report.hours.filter((row) => row.flags === 2).map((row) => row.turns), [1]);
    assert.equal(report.sessions.length, EXPECTED.sessions);
    assert.equal(new Set(report.sessions.map((session) => session.project)).size, EXPECTED.projects);
    const [one, two, resumed, four] = report.sessions;
    for (const [key, value] of Object.entries(EXPECTED.sessionOne)) assert.equal(one[key], value, `one.${key}`);
    for (const [key, value] of Object.entries(EXPECTED.sessionTwo)) assert.equal(two[key], value, `two.${key}`);
    assert.equal(resumed.turns, 1);
    assert.equal(resumed.tokens, 3);
    assert.equal(resumed.project, one.project);
    for (const [key, value] of Object.entries(EXPECTED.sessionFour)) assert.equal(four[key], value, `four.${key}`);
    const limits = {};
    for (const row of report.limits) limits[row.kind] = (limits[row.kind] ?? 0) + row.count;
    assert.deepEqual(limits, EXPECTED.limits);
  });

  it("matches the golden report byte for byte (apart from when and where it ran)", () => {
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, steady(dry.stdout));
    assert.equal(steady(dry.stdout), readFileSync(GOLDEN, "utf8"));
  });

  it("sends no text, path, project name or id from the transcripts", () => {
    const needles = [CANARY, "evil", "toolu_", "msg_", "req_", "secret", "ünïcode", "/Users", "-work-other", "feature/"];
    for (const needle of [...needles, ...Object.values(SID), ...Object.values(CWD)]) {
      assert.ok(!dry.stdout.includes(needle), needle);
    }
    for (const line of dry.stdout.trimEnd().split("\n").slice(2)) assert.match(line, /^[MHSL](\t[a-z0-9._-]+)+$/);
  });

  it("never takes a model name from a tool call's input", async () => {
    const dir = path.join(ROOT, "model-after-content", "projects", "-work-tool");
    mkdirSync(dir, { recursive: true });
    const row = JSON.stringify({
      cwd: "/work/tool",
      sessionId: "0b5c3a7e-1f2d-4c6b-9a8e-7d6c5b4a3f21",
      message: {
        id: "msg_tool",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "x", input: { model: "leakyword" } }],
        model: "claude-opus-4-1",
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      requestId: "req_tool",
      type: "assistant",
      uuid: "6f1e2d3c-4b5a-4968-8776-655443322110",
      timestamp: "2026-09-01T10:00:00.000Z",
    });
    writeFileSync(path.join(dir, "s.jsonl"), `${row}\n`);
    const result = await run(["--dry-run", "--dir", path.join(ROOT, "model-after-content")]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes("leakyword"));
    assert.deepEqual(parseReport(result.stdout).models, ["other"]);
  });

  it("says what it will send on stderr, and that nothing was sent", () => {
    assert.ok(dry.stderr.includes("Sends: counts per hour, model names, token totals, effort levels,"));
    assert.ok(dry.stderr.includes("Found 4 sessions in 3 projects: 11 model calls."));
    assert.ok(dry.stderr.includes("Never sends: your prompts, Claude's replies, file paths or project names."));
    assert.ok(dry.stderr.includes("Nothing was sent."));
    assert.equal(stub.uploads.length, 0);
  });
});

describe("report.sh finds the transcripts", { skip }, () => {
  it("in ~/.claude when nothing is named", async () => {
    const result = await run(["--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseReport(result.stdout).sessions.length, EXPECTED.sessions);
  });

  it("in every folder of CLAUDE_CONFIG_DIR, and in a projects folder named with --dir", async () => {
    const viaEnv = await run(["--dry-run"], { HOME: EMPTY_HOME, CLAUDE_CONFIG_DIR: `${path.join(ROOT, "missing")},${CONFIG}` });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    const viaProjects = await run(["--dry-run", "--dir", path.join(CONFIG, "projects")], { HOME: EMPTY_HOME });
    assert.equal(steady(viaProjects.stdout), steady(viaEnv.stdout));
  });

  it("says where it looked when there is no Claude Code data", async () => {
    const result = await run(["--dry-run"], { HOME: EMPTY_HOME });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("No Claude Code data found. Looked in:"));
    assert.ok(result.stderr.includes("--dir"));
    assert.equal(result.stdout, "");
  });

  it("says so when the files hold no usage in the chosen days", async () => {
    const result = await run(["--dry-run", "--days", "1", "--dir", CONFIG]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("No Claude Code usage found in 6 files."));
  });

  it("refuses an unknown option", async () => {
    const result = await run(["--send-everything"]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("Unknown option --send-everything"));
  });
});

// Every openssl this machine has: LibreSSL (macOS /usr/bin/openssl), OpenSSL 3 (Linux, Homebrew).
const OPENSSLS = ["/usr/bin/openssl", "/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"].filter(existsSync);

for (const [index, openssl] of OPENSSLS.entries()) {
  describe(`report.sh uploads with ${openssl}`, { skip }, () => {
    const bin = path.join(ROOT, `bin-${index}`);
    const env = () => ({ PATH: `${bin}:/usr/bin:/bin`, SHURIKEN_REPORT_ORIGIN: stub.origin });
    before(() => {
      mkdirSync(bin, { recursive: true });
      if (!existsSync(path.join(bin, "openssl"))) symlinkSync(openssl, path.join(bin, "openssl"));
    });

    it("encrypts what the dry run shows, and the page's decrypt opens it", async () => {
      stub.answer = { status: 200, body: `ok ${REPORT_ID} ${DELETE_TOKEN} 2026-11-22T10:00:00Z\n` };
      stub.uploads.length = 0;
      const dry = await run(["--dry-run", "--dir", CONFIG], env());
      const sent = await run(["--yes", "--dir", CONFIG], env());
      assert.equal(sent.code, 0, sent.stderr);
      assert.equal(stub.uploads.length, 1);
      const link = sent.stdout.match(/https?:\/\/\S+/)?.[0] ?? "";
      assert.ok(link.startsWith(`${stub.origin}/tools/claude-code-usage-dashboard/report#`), link);
      const fragment = readFragment(new URL(link).hash);
      assert.equal(fragment.report, REPORT_ID);
      assert.equal(fragment.deleteToken, DELETE_TOKEN);
      assert.match(fragment.key, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(sent.stdout.includes("Only you can see this. We can't read it: the key never leaves your link."));
      assert.ok(sent.stdout.includes("It is deleted on 2026-11-22."));

      const envelope = stub.uploads[0];
      assert.equal(envelope.subarray(0, 5).toString("latin1"), "SKUR\u0001");
      assert.equal((envelope.length - 53) % 16, 0);
      // The key never travels with the upload.
      assert.ok(!envelope.toString("latin1").includes(fragment.key));
      const opened = openEnvelope(envelope, fragment.key);
      assert.equal(opened.ok, true, opened.reason);
      assert.equal(steady(opened.text), steady(dry.stdout));

      // A changed byte, an unknown version and a wrong key are each refused before any decrypt.
      const flipped = Buffer.from(envelope);
      flipped[30] ^= 1;
      assert.deepEqual(openEnvelope(flipped, fragment.key), { ok: false, reason: "bad-key" });
      const newer = Buffer.from(envelope);
      newer[4] = 2;
      assert.deepEqual(openEnvelope(newer, fragment.key), { ok: false, reason: "newer-version" });
      // The FIRST character: the 43rd carries only 4 bits, so two letters there can be one key.
      const otherKey = (fragment.key.startsWith("A") ? "B" : "A") + fragment.key.slice(1);
      assert.deepEqual(openEnvelope(envelope, otherKey), { ok: false, reason: "bad-key" });
    });

    it("asks before sending, and with no terminal to ask in sends nothing", async () => {
      stub.uploads.length = 0;
      const result = await run(["--dir", CONFIG], env());
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes("Run it again with --yes to send."));
      assert.equal(stub.uploads.length, 0);
    });

    it("passes on the server's refusal in one line", async () => {
      stub.answer = { status: 429, body: "error busy Too many reports from this address. Try again in an hour.\n" };
      const result = await run(["--yes", "--dir", CONFIG], env());
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes("The upload was refused (429): Too many reports from this address. Try again in an hour."));
      assert.equal(result.stdout, "");
    });

    it("links to the Dutch report page for a Dutch terminal", async () => {
      stub.answer = { status: 200, body: `ok ${REPORT_ID} ${DELETE_TOKEN} 2026-11-22T10:00:00Z\n` };
      const result = await run(["--yes", "--dir", CONFIG], { ...env(), LANG: "nl_NL.UTF-8" });
      assert.ok(result.stdout.includes(`${stub.origin}/nl/tools/claude-code-usage-dashboard/report#r=${REPORT_ID}&k=`));
    });
  });
}

describe("report.sh network and origin errors", { skip }, () => {
  it("says so when the server can't be reached", async () => {
    const result = await run(["--yes", "--dir", CONFIG], { SHURIKEN_REPORT_ORIGIN: `http://127.0.0.1:${await closedPort()}` });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("Couldn't reach"));
    assert.ok(result.stderr.includes("Check your internet connection"));
  });

  it("never sends over plain http to another host", async () => {
    const result = await run(["--yes", "--dir", CONFIG], { SHURIKEN_REPORT_ORIGIN: "http://example.com" });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("must start with https://"));
  });
});
