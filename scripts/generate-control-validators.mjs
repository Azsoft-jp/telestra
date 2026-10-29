// JSON SchemaからWorker用の検証器を生成し、実行時の動的コード生成を避ける。
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standalone from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  strictRequired: false,
  code: { source: true, esm: true },
});
addFormats(ajv);
for (const name of readdirSync("contracts")
  .filter((n) => n.endsWith(".schema.json"))
  .sort())
  ajv.addSchema(JSON.parse(readFileSync(`contracts/${name}`, "utf8")));
const control = JSON.parse(
  readFileSync("contracts/control.schema.json", "utf8"),
);
const exports = Object.fromEntries(
  Object.keys(control.$defs).map((name) => [
    name,
    `${control.$id}#/$defs/${name}`,
  ]),
);
// Ajvの補助関数も事前にまとめ、NodeとWorkerで同じES Moduleを読み込む。
const bundled = await build({
  stdin: {
    contents: standalone(ajv, exports),
    resolveDir: process.cwd(),
    sourcefile: "control-validators.js",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2023",
  legalComments: "none",
  minify: true,
});
const source =
  "// JSON Schemaから自動生成。直接編集せず、生成元で契約を更新する。\n" +
  bundled.outputFiles[0].text;
const declaration =
  "// Schema検証器の型を自動生成する。直接編集しない。\n" +
  Object.keys(exports)
    .map((name) => `export declare function ${name}(value: unknown): boolean;`)
    .join("\n") +
  "\n";
for (const [name, contents] of [
  ["runtime.mjs", source],
  ["runtime.d.mts", declaration],
]) {
  const target = `packages/control-contracts/${name}`;
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== contents)
      throw new Error("制御契約の検証コードを再生成してください。");
  } else writeFileSync(target, contents);
}
