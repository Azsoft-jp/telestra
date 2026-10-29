// Goのrace検査を実行し、成功・失敗をログとJSONへ記録する。
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("artifacts", { recursive: true });
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* ZIP展開直後はGitのcommitがないため、nullのまま記録する。 */
}
const result = spawnSync("go", ["test", "-race", "./..."], {
  encoding: "utf8",
  timeout: 120_000,
  env: { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off" },
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);
writeFileSync("artifacts/go-test-output.txt", output);
writeFileSync(
  "artifacts/go-results.json",
  JSON.stringify(
    {
      testId: "GO-01",
      commit,
      environment: `local; ${process.platform}/${process.arch}`,
      fixtureId: "synthetic-ts-and-local-wss-control-v2",
      expected:
        "Go Mock, WSS/TLS, signed control, durable journal and error-check tests pass under race detector",
      actual: output.trim(),
      status: result.status === 0 ? "pass" : "fail",
      evidenceUri: "artifacts/go-test-output.txt",
      timestamp: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
process.exitCode = result.status === 0 ? 0 : 1;
