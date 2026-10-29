// Goで検証する契約を固定して埋め込み、未対応のSchema制約が加わった場合は生成を止める。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const sources = ["control", "capture-permit"];
const schemaKeys = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "const",
  "enum",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "items",
  "maxItems",
  "uniqueItems",
  "maxProperties",
  "format",
]);
function inspect(schema) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("Goではオブジェクト形式のSchemaだけを扱います。");
  for (const key of Object.keys(schema))
    if (!schemaKeys.has(key))
      throw new Error(`Goで未対応のSchema制約です: ${key}`);
  if (
    schema.type !== undefined &&
    !["object", "array", "string", "integer", "number", "boolean"].includes(
      schema.type,
    )
  )
    throw new Error("Goで未対応のtypeです。");
  const groups = [
    [
      ["properties", "required", "additionalProperties", "maxProperties"],
      ["object"],
    ],
    [["items", "maxItems", "uniqueItems"], ["array"]],
    [["minLength", "maxLength", "pattern", "format"], ["string"]],
    [
      ["minimum", "maximum"],
      ["integer", "number"],
    ],
  ];
  for (const [keys, types] of groups)
    if (keys.some((key) => key in schema) && !types.includes(schema.type))
      throw new Error("Goで制約を検証するには対応するtypeが必要です。");
  if (
    schema.$ref &&
    Object.keys(schema).some(
      (key) => !["$ref", "title", "description"].includes(key),
    )
  )
    throw new Error("Goでは$refの兄弟制約をまだ扱えません。");
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  )
    throw new Error("Goでは追加項目のSchemaをまだ扱えません。");
  if (schema.format !== undefined && schema.format !== "date-time")
    throw new Error("Goで未対応のformatです。");
  // JavaScriptとGoで正規表現の機能が異なるため、確認済みのパターンだけを許可する。
  if (
    schema.pattern !== undefined &&
    ![
      "^[A-Za-z0-9_.:-]{3,128}$",
      "^[A-Za-z0-9_-]{43}$",
      "^[a-f0-9]{64}$",
      "^[A-Za-z0-9_.:-]+$",
    ].includes(schema.pattern)
  )
    throw new Error("Goで未確認のpatternです。");
  for (const child of Object.values(schema.properties ?? {})) inspect(child);
  for (const child of Object.values(schema.$defs ?? {})) inspect(child);
  if (schema.items) inspect(schema.items);
}
const documents = Object.fromEntries(
  sources.map((name) => {
    const schema = JSON.parse(
      readFileSync(`contracts/${name}.schema.json`, "utf8"),
    );
    inspect(schema);
    return [schema.$id, schema];
  }),
);
const source = `// JSON Schemaから自動生成。直接編集せず、npm run generateで更新する。\npackage wire\n\nconst schemaDocuments = ${JSON.stringify(JSON.stringify(documents))}\n`;
const formatted = spawnSync("gofmt", [], { input: source, encoding: "utf8" });
if (formatted.status !== 0)
  throw new Error("Goの契約データを整形できませんでした。");
const target = "nodes/tuner/wire/contracts_generated.go";
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== formatted.stdout)
    throw new Error("Goの契約データを再生成してください。");
} else writeFileSync(target, formatted.stdout);
