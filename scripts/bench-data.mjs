// Writes a large made-up Claude Code config folder for timing the scripts: a heavy user's year of
// transcripts, shaped like what the CLI writes (one API request split into a row per content
// block, thinking blocks with long signatures, tool calls with big inputs, tool results with whole
// files, agent progress rows that nest assistant messages). Never anyone's real data.
//   node scripts/bench-data.mjs <folder> [megabytes=1000]
//   time bash report.sh --dir <folder> --dry-run > /dev/null
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

const out = process.argv[2];
const targetMb = Number(process.argv[3] ?? 1000);
if (!out) throw new Error("usage: node scripts/bench-data.mjs <folder> [megabytes]");

const rand = Math.random;
const pick = (list) => list[Math.floor(rand() * list.length)];
// A long-tailed size: most small, a few very large (a whole file read, a big Write).
const size = (median, max) => Math.min(max, Math.round(median * Math.exp((rand() - 0.5) * 4)));
const filler = (n) => "lorem ipsum dolor sit amet, \\\"quoted\\\" {braces} [x] ".repeat(Math.ceil(n / 48)).slice(0, n);
const hex = (n) => randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
const uuid = () => randomUUID();
const MODELS = ["claude-opus-4-6", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"];

let written = 0;
let t = Date.parse("2025-10-01T08:00:00Z");
const projects = Array.from({ length: 40 }, (_, i) => `/Users/dev/project-${i}`);

async function session(file, sid, cwd) {
  mkdirSync(path.dirname(file), { recursive: true });
  const stream = createWriteStream(file);
  const write = (row) => {
    const line = JSON.stringify(row) + "\n";
    written += line.length;
    if (!stream.write(line)) return new Promise((resolve) => stream.once("drain", resolve));
  };
  const base = () => ({ parentUuid: uuid(), isSidechain: false, userType: "external", cwd, sessionId: sid, version: "2.1.27", gitBranch: "main" });
  const turns = 2 + Math.floor(rand() * 25);
  const model = pick(MODELS);
  for (let turn = 0; turn < turns; turn++) {
    t += 30_000 + Math.floor(rand() * 600_000);
    await write({ ...base(), type: "user", message: { role: "user", content: filler(size(300, 20_000)) }, uuid: uuid(), timestamp: new Date(t).toISOString() });
    const calls = 1 + Math.floor(rand() * 12);
    for (let call = 0; call < calls; call++) {
      t += 2_000 + Math.floor(rand() * 40_000);
      const usage = { input_tokens: 3, cache_creation_input_tokens: size(2000, 60_000), cache_read_input_tokens: size(60_000, 900_000), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: size(400, 30_000), service_tier: "standard" };
      const msg = `msg_${hex(24)}`;
      const req = `req_${hex(24)}`;
      const blocks = [
        { type: "thinking", thinking: filler(size(800, 20_000)), signature: hex(size(1500, 6000)) },
        { type: "text", text: filler(size(400, 8000)) },
        { type: "tool_use", id: `toolu_${hex(20)}`, name: pick(["Read", "Edit", "Write", "Bash", "Grep"]), input: { file_path: `${cwd}/src/file.ts`, content: filler(size(1500, 200_000)) } },
      ];
      for (const block of blocks) {
        await write({ ...base(), message: { id: msg, type: "message", role: "assistant", model, content: [block], stop_reason: null, stop_sequence: null, usage }, requestId: req, type: "assistant", uuid: uuid(), timestamp: new Date(t).toISOString() });
      }
      await write({ ...base(), type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_x", type: "tool_result", content: filler(size(4000, 250_000)) }] }, uuid: uuid(), timestamp: new Date(t + 500).toISOString(), toolUseResult: { stdout: filler(size(2000, 100_000)) } });
      if (rand() < 0.15) {
        await write({ ...base(), type: "progress", data: { type: "agent_progress", message: { type: "assistant", message: { id: `msg_${hex(24)}`, model, content: [{ type: "text", text: filler(size(3000, 50_000)) }], usage } } }, uuid: uuid(), timestamp: new Date(t).toISOString() });
      }
    }
    await write({ ...base(), type: "system", subtype: "turn_duration", durationMs: 60_000, timestamp: new Date(t).toISOString(), uuid: uuid() });
  }
  await new Promise((resolve) => stream.end(resolve));
}

let n = 0;
while (written < targetMb * 1024 * 1024) {
  const cwd = pick(projects);
  const sid = uuid();
  await session(path.join(out, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sid}.jsonl`), sid, cwd);
  n++;
}
process.stdout.write(`${n} sessions, ${(written / 1048576).toFixed(0)} MB in ${out}\n`);
