// 試験プロセスの結果と必須IDの証跡を照合し、一括検査の合否を記録する。
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAcceptance } from "./acceptance-gate.ts";

// Phase 01の部分試験は別の証跡に記録し、Phase全体の完了とは区別する。
const browser = process.argv.includes("--browser");
const phase01 = browser || process.argv.includes("--phase01");
const label = browser ? "browser" : phase01 ? "phase01" : "phase00";
const phase = phase01 ? "01" : "00";
const environment = browser
  ? "isolated Chromium + four loopback TLS origins + memory Mock IdP + local Worker; local self-signed TLS exception; outward page requests denied"
  : phase01
    ? "local-workerd + local-D1 + memory Mock IdP/public-client PKCE + loopback Go WSS/TLS; outward fetch denied"
    : "local-mock and isolated Capture Permit v2 crypto; no tuner/cloud/real media connection";
const run = new Date().toISOString().replaceAll(":", "-");
const directory = `artifacts/runs/${label}-${run}`;
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
      /\.(ts|mts|go|mod|sum|json|mjs|md|yml|sql|py|html|css|svg)$/.test(file) &&
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
const testsDirectory = browser
  ? "tests/browser"
  : phase01
    ? "tests/phase01"
    : "tests";
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
      // ブラウザのdebug・TLS鍵ログを無効にし、URLや資格を診断出力へ残さない。
      ...(browser ? { DEBUG: "", PWDEBUG: "0", SSLKEYLOGFILE: "" } : {}),
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
writeFileSync(
  `artifacts/${browser ? "browser-" : phase01 ? "phase01-" : ""}test-output.txt`,
  output,
);
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
  browser
    ? ["SEC-04", "CORE-02", "UX-08"]
    : phase01
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
  command: browser
    ? "npm run browser:check"
    : phase01
      ? "npm run control:test"
      : "npm test",
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
  scope: browser
    ? "Local Chromium popup/PKCE/API fixture over loopback self-signed TLS; WebKit, mobile/PWA, real IdP, production TLS and complete frontend security validation pending"
    : phase01
      ? "Local HTTP + memory public-client PKCE/API sessions + DO WebSocket + Go loopback WSS/TLS identity, provisioning, rotation, process restart, reconnect, replay and bounded command checks; actual Chromium is recorded separately; full login UI, mobile/PWA, production KeyProvider, deployed IdP, signed capture policy persistence, storage grant enforcement, capture execution and production validation pending"
      : "Mock contracts and isolated Capture Permit v2 verification; no full security, codec, ARIB, PWA, DR or SLO certification",
};
writeFileSync(
  `artifacts/${label}-results.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`検証記録: artifacts/${label}-results.json`);
if (acceptance.status !== "pass")
  console.error(
    `受け入れ検証に失敗しました: ${acceptance.issues.join(", ")}; 不足ID: ${acceptance.missingTestIds.join(", ")}`,
  );
process.exitCode = report.exitCode;
