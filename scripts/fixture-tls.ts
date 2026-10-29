// 固定したGo fixtureで一時TLS素材を作り、IPCの値をファイルや例外へ残さない。
import { spawnSync } from "node:child_process";

export function fixtureTLS(): { certificate: string; key: string } {
  const result = spawnSync("go", ["run", "./nodes/tuner/cmd/controlfixture"], {
    input: JSON.stringify({ mode: "tls-material" }),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16_384,
    env: {
      ...process.env,
      GOTOOLCHAIN: "local",
      GOPROXY: "off",
      GOSUMDB: "off",
    },
  });
  try {
    if (result.status !== 0 || result.error)
      throw new Error("TLS素材を作成できません。");
    const value = JSON.parse(result.stdout) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).sort().join(",") !== "certificate,key" ||
      !("certificate" in value) ||
      typeof value.certificate !== "string" ||
      !("key" in value) ||
      typeof value.key !== "string"
    )
      throw new Error("TLS素材を確認できません。");
    return { certificate: value.certificate, key: value.key };
  } catch {
    throw new Error(
      "試験用TLS素材を作成できません。Goと依存物を確認してください。",
    );
  }
}
