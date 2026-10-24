import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Made-up Claude Code transcripts for the tests. Never anyone's real data: the row shapes follow
// what the Claude Code CLI writes to ~/.claude/projects. Every row a script must leave out carries
// CANARY or a path, so a leak shows up in the privacy test.
//
// Four sessions in three projects over five days, with: streamed duplicate rows, cache writes
// (5 min and 1 h), fast mode, US-only inference, web searches, a <synthetic> row, a subagent file,
// a resumed session that copies an earlier request, three effort sources (/effort, effortLevel,
// thinkingMetadata) plus Ultra Code, limit rows (five_hour, seven_day, unknown, missing), turn
// times, a progress row that nests an assistant message, a tool call whose input has "model" and
// "usage" keys, a model id with spaces, counts above 2^31, CRLF line ends, malformed lines, a
// 5 MB line and a cut-off last line.

export const CANARY = "CANARY-7f3a";
export const SID = {
  one: "11111111-1111-4111-8111-111111111111",
  two: "22222222-2222-4222-8222-222222222222",
  resumed: "33333333-3333-4333-8333-333333333333",
  four: "44444444-4444-4444-8444-444444444444",
};
export const CWD = {
  secret: "/Users/dev/secret-project-name",
  unicode: "/Users/dev/my app ünïcode",
  other: "/work/other",
};
export const MODEL = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};

let uuids = 0;
const uuid = () => `aaaaaaaa-0000-4000-8000-${String(++uuids).padStart(12, "0")}`;

function base(sid, cwd, side = false) {
  return {
    parentUuid: null,
    isSidechain: side,
    userType: "external",
    cwd,
    sessionId: sid,
    version: "2.1.27",
    gitBranch: `feature/${CANARY}`,
  };
}

function assistant(call, extra = {}) {
  return JSON.stringify({
    ...base(call.sid, call.cwd, call.side),
    message: {
      id: call.msg,
      type: "message",
      role: "assistant",
      model: call.model,
      content: call.content ?? [{ type: "text", text: `Done. ${CANARY} in ${call.cwd}` }],
      stop_reason: null,
      stop_sequence: null,
      usage: call.usage,
    },
    ...(call.req ? { requestId: call.req } : {}),
    type: "assistant",
    uuid: uuid(),
    timestamp: call.ts,
    ...extra,
  });
}

function user(sid, cwd, ts, content, extra = {}) {
  return JSON.stringify({
    ...base(sid, cwd),
    ...extra,
    type: "user",
    message: { role: "user", content },
    uuid: uuid(),
    timestamp: ts,
  });
}

function effortCommand(sid, cwd, ts, level) {
  return user(
    sid,
    cwd,
    ts,
    `<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>${level}</command-args>`
  );
}

function turnDuration(sid, cwd, ts, ms) {
  return JSON.stringify({
    ...base(sid, cwd),
    type: "system",
    subtype: "turn_duration",
    durationMs: ms,
    messageCount: 4,
    timestamp: ts,
    uuid: uuid(),
    isMeta: false,
  });
}

function limitRow(sid, cwd, ts, kind) {
  return JSON.stringify({
    ...base(sid, cwd),
    message: {
      id: `msg_limit_${uuids}`,
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: `You've hit your limit · resets 3pm. ${CANARY}` }],
      stop_reason: "stop_sequence",
      stop_sequence: "",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    type: "assistant",
    uuid: uuid(),
    timestamp: ts,
    error: "rate_limit",
    isApiErrorMessage: true,
    apiError: "usage_limit_reached",
    ...(kind ? { quotaLimits: { status: "rejected", rateLimitType: kind, utilization: 1 } } : {}),
  });
}

const folder = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/** Writes the fixture home's transcripts under `<configDir>/projects/`. */
export function writeFixtureTranscripts(configDir) {
  uuids = 0;
  const projects = path.join(configDir, "projects");
  const write = (cwd, file, lines, eol = "\n", end = eol) => {
    const full = path.join(projects, folder(cwd), file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, lines.join(eol) + end);
  };
  const one = (ts, rest) => ({ sid: SID.one, cwd: CWD.secret, ts, ...rest });
  const c1 = (output) =>
    one("2026-09-01T10:00:00.000Z", {
      msg: "msg_A1",
      req: "req_A1",
      model: MODEL.opus,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 5000,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
        output_tokens: output,
        service_tier: "standard",
      },
    });

  // Session one: /effort xhigh, a streamed request written twice, fast + US + web search with a
  // hostile tool call, a <synthetic> row, a nested progress row, /effort ultracode, turn times.
  write(CWD.secret, `${SID.one}.jsonl`, [
    user(SID.one, CWD.secret, "2026-09-01T09:58:00.000Z", `Fix the login bug ${CANARY}`),
    effortCommand(SID.one, CWD.secret, "2026-09-01T09:59:00.000Z", "xhigh"),
    assistant(c1(5)),
    assistant(c1(50)),
    assistant(
      one("2026-09-01T10:05:00.000Z", {
        msg: "msg_A2",
        req: "req_A2",
        model: MODEL.opus,
        content: [
          { type: "text", text: `Here is "model":"evil" and {"usage":{"output_tokens":777}} ${CANARY}` },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Agent",
            input: { model: "evil", usage: { input_tokens: 888888, output_tokens: 999999 }, prompt: CANARY },
          },
        ],
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 6000,
          output_tokens: 100,
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
          service_tier: "standard",
          inference_geo: "us",
          speed: "fast",
        },
      })
    ),
    assistant(
      one("2026-09-01T10:06:00.000Z", {
        msg: "msg_syn",
        req: "req_syn",
        model: "<synthetic>",
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    ),
    turnDuration(SID.one, CWD.secret, "2026-09-01T10:06:30.000Z", 360000),
    JSON.stringify({
      ...base(SID.one, CWD.secret),
      type: "progress",
      data: {
        message: {
          message: { id: "msg_nested", model: MODEL.opus, usage: { input_tokens: 5, output_tokens: 5000 } },
          requestId: "req_nested",
          type: "assistant",
          timestamp: "2026-09-01T10:07:00.000Z",
        },
      },
      uuid: uuid(),
      timestamp: "2026-09-01T10:07:00.000Z",
    }),
    effortCommand(SID.one, CWD.secret, "2026-09-01T10:19:00.000Z", "ultracode"),
    assistant(
      one("2026-09-01T10:20:00.000Z", {
        msg: "msg_A3",
        req: "req_A3",
        model: MODEL.sonnet,
        usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 10 },
      })
    ),
    turnDuration(SID.one, CWD.secret, "2026-09-01T10:21:00.000Z", 60000),
  ]);
  // Its subagent: same session id, isSidechain true, its own file.
  write(CWD.secret, `${SID.one}/subagents/agent-a1b2c3.jsonl`, [
    assistant({
      sid: SID.one,
      cwd: CWD.secret,
      ts: "2026-09-01T10:10:00.000Z",
      msg: "msg_A4",
      req: "req_A4",
      model: MODEL.haiku,
      side: true,
      usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 },
    }),
  ]);

  // Session two (spaces and Unicode in its folder): effortLevel, a time with an offset and no
  // milliseconds, a request without a requestId, legacy thinkingMetadata, a model id the script
  // must not trust, and a cache read above 2^31.
  const two = (ts, rest) => ({ sid: SID.two, cwd: CWD.unicode, ts, ...rest });
  const small = (n) => ({
    input_tokens: n,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: n,
  });
  write(CWD.unicode, `${SID.two}.jsonl`, [
    user(SID.two, CWD.unicode, "2026-09-02T08:00:00+02:00", `Start ${CANARY}`, { effortLevel: "high" }),
    assistant(
      two("2026-09-02T08:30:00+02:00", {
        msg: "msg_B1",
        req: "req_B1",
        model: MODEL.sonnet,
        usage: { input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 0, output_tokens: 30 },
      })
    ),
    assistant(two("2026-09-02T06:31:00Z", { msg: "msg_B2", model: MODEL.sonnet, usage: small(1) })),
    user(SID.two, CWD.unicode, "2026-09-02T06:40:00.000Z", `Think harder ${CANARY}`, {
      thinkingMetadata: { level: "medium", disabled: false, triggers: [] },
    }),
    assistant(two("2026-09-02T06:45:00.000Z", { msg: "msg_B3", req: "req_B3", model: "evil model!", usage: small(7) })),
    assistant(
      two("2026-09-02T07:00:00.000Z", {
        msg: "msg_B4",
        req: "req_B4",
        model: MODEL.opus,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 3_000_000_000,
          output_tokens: 1,
        },
      })
    ),
  ]);

  // A resumed session with CRLF line ends: it copies request A1 (counted once, in session one)
  // and adds one request of its own.
  write(
    CWD.secret,
    `${SID.resumed}.jsonl`,
    [
      assistant({ ...c1(50), sid: SID.resumed }),
      assistant({
        sid: SID.resumed,
        cwd: CWD.secret,
        ts: "2026-09-03T12:00:00.123Z",
        msg: "msg_C1",
        req: "req_C1",
        model: MODEL.opus,
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ],
    "\r\n"
  );

  // Session four: limits, broken lines, a 5 MB line, and a last line cut off mid-write.
  const four = (ts, rest) => ({ sid: SID.four, cwd: CWD.other, ts, ...rest });
  const cut = assistant(
    four("2026-09-06T02:00:00.000Z", { msg: "msg_D9", req: "req_D9", model: MODEL.opus, usage: small(9) })
  );
  write(
    CWD.other,
    `${SID.four}.jsonl`,
    [
      assistant(
        four("2026-09-05T23:30:00.000Z", { msg: "msg_D1", req: "req_D1", model: MODEL.sonnet, usage: small(10) })
      ),
      limitRow(SID.four, CWD.other, "2026-09-05T23:40:00.000Z", "five_hour"),
      '{"type":"assistant","message":{"usage":{"output_tokens":',
      "not json at all",
      limitRow(SID.four, CWD.other, "2026-09-06T00:10:00.000Z", "seven_day"),
      limitRow(SID.four, CWD.other, "2026-09-06T00:20:00.000Z", "weird_new_kind"),
      limitRow(SID.four, CWD.other, "2026-09-06T00:25:00.000Z", null),
      assistant(
        four("2026-09-06T01:00:00.000Z", {
          msg: "msg_D2",
          req: "req_D2",
          model: MODEL.haiku,
          content: [{ type: "text", text: `${CANARY} ${"x".repeat(5 * 1024 * 1024)}` }],
          usage: small(1),
        })
      ),
      cut.slice(0, cut.indexOf('"usage"') - 5),
    ],
    "\n",
    ""
  );
  // A row whose session id is not a UUID, and a file that is not a transcript.
  write(CWD.other, "notes.jsonl", [
    assistant(four("2026-09-06T03:00:00.000Z", { msg: "m", req: "r", model: MODEL.opus, usage: small(1) })).replace(
      SID.four,
      "../../etc"
    ),
  ]);
  writeFileSync(path.join(projects, folder(CWD.other), "README.txt"), CANARY);
}

/** What the fixtures must add up to (worked out by hand from the rows above). */
export const EXPECTED = {
  models: [MODEL.haiku, MODEL.opus, MODEL.sonnet, "other"],
  calls: 11,
  sessions: 4,
  projects: 3,
  firstCall: Date.parse("2026-09-01T10:00:00Z") / 1000,
  lastCall: Date.parse("2026-09-06T01:00:00Z") / 1000,
  /** Session one: 4 calls (one from its subagent), active 60 + (300+60) × 2 + (600+60) seconds. */
  sessionOne: { turns: 4, subagentTurns: 1, activeSeconds: 1440, tokens: 13495, workedMs: 420000, topModel: 1 },
  /** Session two: gaps of 60, 840 and 900 seconds (900 still counts as one sitting): 4 × 60 + 1800. */
  sessionTwo: { turns: 4, activeSeconds: 2040, tokens: 3_000_000_250 },
  sessionFour: { turns: 2, activeSeconds: 120, limitHits: 4 },
  input: 10 + 20 + 1000 + 5 + 3 + 1 + 7 + 0 + 1 + 10 + 1,
  output: 50 + 100 + 200 + 10 + 30 + 1 + 7 + 1 + 2 + 10 + 1,
  cacheRead: 5000 + 6000 + 100 + 3_000_000_000,
  cacheWrite: 1000 + 200,
  cacheWrite1h: 600,
  webSearches: 2,
  /** Calls per effort code: none 3 (resumed + session four), medium 2, high 2, xhigh 3, ultracode 1. */
  effort: { 0: 3, 2: 2, 3: 2, 4: 3, 6: 1 },
  limits: { five_hour: 1, seven_day: 1, throttle: 2 },
};
