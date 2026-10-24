// Shared by the tests: a reader for the report format (docs/FORMAT.md), the stub upload server
// and the two values that change from run to run.
import { createServer } from "node:http";

/** The report's text with "when it ran", "where it ran" and "which script" blanked. */
export const steady = (tsv) =>
  tsv
    .replace(/\tgenerated=[0-9]+/, "\tgenerated=0")
    .replace(/\ttz=[+-][0-9]{4}/, "\ttz=+0000")
    .replace("\tscript=ps1-", "\tscript=sh-");

const ROW = {
  "#v": /^#v\t1$/,
  "#meta":
    /^#meta\tgenerated=[0-9]+\ttz=[+-][0-9]{4}\tscript=(sh|ps1)-[0-9]+\.[0-9]+\.[0-9]+\tfiles=[0-9]+\tfirst=[0-9]+\tlast=[0-9]+\ttruncated_sessions=[0-9]+$/,
  M: /^M\t[0-9]+\t[a-z0-9][a-z0-9._-]{0,63}$/,
  H: /^H(\t[0-9]+){11}$/,
  S: /^S(\t[0-9]+){10}$/,
  L: /^L\t[0-9]+\t(five_hour|seven_day|seven_day_opus|seven_day_sonnet|seven_day_overage_included|overage|throttle)\t[0-9]+$/,
};

/** Parses a report; throws on any line the dashboard would refuse. */
export function parseReport(tsv) {
  if (!tsv.endsWith("\n")) throw new Error("the report must end with a newline");
  const lines = tsv.slice(0, -1).split("\n");
  const report = { meta: {}, models: [], hours: [], sessions: [], limits: [] };
  lines.forEach((line, index) => {
    const kind = line.split("\t", 1)[0];
    if (!ROW[kind]?.test(line)) throw new Error(`line ${index + 1} is not a report row: ${JSON.stringify(line)}`);
    if ((index === 0) !== (kind === "#v") || (index === 1) !== (kind === "#meta")) throw new Error(`line ${index + 1} is out of order`);
    const f = line.split("\t").slice(1);
    const n = f.map(Number);
    if (kind === "#meta") {
      for (const pair of f) {
        const [key, value] = pair.split("=");
        report.meta[key] = key === "script" || key === "tz" ? value : Number(value);
      }
    } else if (kind === "M") report.models.push(f[1]);
    else if (kind === "H") {
      const [hour, model, effort, flags, turns, input, output, cacheRead, cacheWrite, cacheWrite1h, webSearches] = n;
      report.hours.push({ hour, model, effort, flags, turns, input, output, cacheRead, cacheWrite, cacheWrite1h, webSearches });
    } else if (kind === "S") {
      const [project, start, end, activeSeconds, turns, subagentTurns, topModel, tokens, workedMs, limitHits] = n;
      report.sessions.push({ project, start, end, activeSeconds, turns, subagentTurns, topModel, tokens, workedMs, limitHits });
    } else if (kind === "L") report.limits.push({ hour: n[0], kind: f[1], count: n[2] });
  });
  return report;
}

export const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);

/** A stand-in for the upload endpoint: records each body, answers like the real one. */
export async function stubServer() {
  const stub = { uploads: [], answer: { status: 200, body: "" }, origin: "" };
  const server = createServer((request, response) => {
    const parts = [];
    request.on("data", (chunk) => parts.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/public/usage-reports") stub.uploads.push(Buffer.concat(parts));
      response.writeHead(stub.answer.status, { "Content-Type": "text/plain" });
      response.end(stub.answer.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.origin = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((resolve) => server.close(resolve));
  return stub;
}

/** A port nothing listens on. */
export async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export const REPORT_ID = "AbCdEfGhIjKlMnOpQrStUv";
export const DELETE_TOKEN = "dElEtE_tOkEn-0123456789abcdefghijklmnopqrstu";
