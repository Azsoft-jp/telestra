// 各試験の期待と実際の結果を記録し、同じ名前の証跡を上書きしない。
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fallbackDirectory = join(
  "artifacts",
  "evidence",
  `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
);

export function scenario(
  testId: string,
  name: string,
  fixtureId: string,
  expected: string,
  run: () => void | Promise<void>,
): void {
  test(`${testId}: ${name}`, async () => {
    let status = "fail";
    try {
      await run();
      status = "pass";
    } finally {
      const directory = process.env.TELESTRA_EVIDENCE_DIR ?? fallbackDirectory;
      mkdirSync(directory, { recursive: true });
      const evidencePath = join(directory, `${testId}-${name}.json`);
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            testId,
            name,
            commit: process.env.TELESTRA_COMMIT ?? null,
            sourceDigest: process.env.TELESTRA_SOURCE_DIGEST ?? null,
            environment: `${process.env.TELESTRA_TEST_ENVIRONMENT ?? "local-mock"}; ${process.platform}/${process.arch}; Node ${process.version}`,
            fixtureId,
            expected,
            actual:
              status === "pass"
                ? "全assertionが成立"
                : "assertionまたは実行が失敗。試験プロセスの出力を確認",
            status,
            evidenceUri: evidencePath,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
    }
  });
}
