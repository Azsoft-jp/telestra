// 試験プロセスの結果と必須IDの証跡を照合し、一括検査の合否を記録する。
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAcceptance } from "./acceptance-gate.ts";

// Phase 01の部分試験は別の証跡に記録し、Phase全体の完了とは区別する。
const phase01 = process.argv.includes("--phase01");
const phase = phase01 ? "01" : "00";
const environment = phase01
  ? "local-workerd + local-D1 + memory Mock IdP/public-client PKCE + loopback Go WSS/TLS; outward fetch denied"
  : "local-mock; no tuner/cloud/real media connection";
const run = new Date().toISOString().replaceAll(":", "-");
const directory = `artifacts/runs/phase${phase}-${run}`;
mkdirSync(directory, { recursive: true });
let commit = "";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* Git未初期化のZIP作業領域では、commitを作らずnullと記録する。 */
}
const hash = createHash("sha256");
function sourceTree(path) {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )) {
    if (
      ["node_modules", ".git", "artifacts", "__pycache__"].includes(entry.name)
    )
      continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) sourceTree(file);
    else if (
      entry.isFile() &&
      /\.(ts|mts|go|mod|sum|json|mjs|md|yml|sql|py)$/.test(file) &&
      !entry.name.startsWith(".env")
    ) {
      hash.update(file);
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
}
sourceTree(".");
const sourceDigest = hash.digest("hex");
const testsDirectory = phase01 ? "tests/phase01" : "tests";
const files = readdirSync(testsDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `${testsDirectory}/${name}`);
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...files],
  {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4_194_304,
    env: {
      ...process.env,
      TELESTRA_EVIDENCE_DIR: directory,
      TELESTRA_COMMIT: commit,
      TELESTRA_SOURCE_DIGEST: sourceDigest,
      TELESTRA_TEST_ENVIRONMENT: environment,
      GOTOOLCHAIN: "local",
      GOPROXY: "off",
      GOSUMDB: "off",
    },
  },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);
writeFileSync(`artifacts/${phase01 ? "phase01-" : ""}test-output.txt`, output);
writeFileSync(`${directory}/test-output.txt`, output);
const records = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => {
    try {
      return JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
    } catch {
      return null;
    }
  });
const acceptance = evaluateAcceptance(
  records,
  {
    exitCode: result.status,
    executionError: Boolean(result.error),
  },
  phase01
    ? [
        "CORE-02",
        "NODE-01",
        "NODE-02",
        "SEC-01",
        "SEC-02",
        "SEC-03",
        "SEC-04",
        "SEC-10",
        "PH01-01",
      ]
    : undefined,
);
const report = {
  phase,
  phaseCompletion: phase01 ? "incomplete" : "mock gate only",
  commit: commit || null,
  sourceDigest,
  timestamp: new Date().toISOString(),
  environment,
  command: phase01 ? "npm run control:test" : "npm test",
  exitCode: acceptance.status === "pass" ? 0 : 1,
  testProcessExitCode: result.status,
  acceptance,
  executionError: result.error ? "test runner failed or timed out" : null,
  results: records.map((record) =>
    record !== null && typeof record === "object" && !Array.isArray(record)
      ? {
          ...record,
          commit: commit || null,
          evidenceUri: `${directory}/test-output.txt`,
        }
      : { status: "fail", code: "INVALID_EVIDENCE" },
  ),
  scope: phase01
    ? "Local HTTP + memory public-client PKCE/API sessions + DO WebSocket + Go loopback WSS/TLS identity, provisioning, rotation, process restart, reconnect, replay and bounded command checks; login UI, browser redirects/CORS, production KeyProvider, deployed IdP, Capture Permit verification and production validation pending"
    : "Mock contracts only; no full security, codec, ARIB, PWA, DR or SLO certification",
};
writeFileSync(
  `artifacts/phase${phase}-results.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`検証記録: artifacts/phase${phase}-results.json`);
if (acceptance.status !== "pass")
  console.error(
    `受け入れ検証に失敗しました: ${acceptance.issues.join(", ")}; 不足ID: ${acceptance.missingTestIds.join(", ")}`,
  );
process.exitCode = report.exitCode;
