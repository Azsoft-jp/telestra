// 固定したGoのMockコマンドを実行し、合成素材の出力をSchemaで検証する。
import { execFileSync } from "node:child_process";
import { validate, boundedJson } from "../packages/contracts/index.ts";
import type { MockCapture } from "../packages/contracts/generated.ts";

// 固定したローカルコマンドを使い、入力からShell・URL・実行パスを組み立てない。
export function tunerFixture(
  backend: "mirakurun" | "mirakc",
  packetSize: 188 | 204 = 188,
): MockCapture {
  const raw = execFileSync(
    "go",
    [
      "run",
      "./nodes/tuner/cmd/mock",
      "--backend",
      backend,
      "--packet-size",
      String(packetSize),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2_097_152,
      env: {
        ...process.env,
        GOTOOLCHAIN: "local",
        GOPROXY: "off",
        GOSUMDB: "off",
      },
    },
  );
  return validate("mock-capture", boundedJson(raw, 2_097_152));
}
