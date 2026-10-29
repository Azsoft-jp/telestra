// 例示JSONと生成型の契約を照合する。署名検証や実機の動作は保証しない。
import { readFileSync } from "node:fs";
import { validate } from "../packages/contracts/index.ts";

for (const [example, schema] of [
  ["node.hello", "node-envelope"],
  ["recording.manifest", "recording-manifest"],
  ["deployment.local", "deployment-profile"],
  ["deployment.dual-static", "deployment-profile"],
] as const) {
  validate(
    schema,
    JSON.parse(readFileSync(`examples/${example}.json`, "utf8")) as unknown,
  );
}
validate(
  "mock-tracks",
  JSON.parse(readFileSync("tests/fixtures/tracks.json", "utf8")) as unknown,
);
console.log(
  "PASS: 全スキーマのコンパイルと例示JSONのDraft 2020-12検証（例示契約の署名は検査対象外）",
);
