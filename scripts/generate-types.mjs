// JSON Schemaの構造を型へ変換し、手書きの型との不一致を防ぐ。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const names = {
  "node-envelope": "NodeEnvelopeBase",
  "capture-permit": "CapturePermit",
  "capture-permit-v2": "CapturePermitV2",
  "capture-policy-v2": "CapturePolicyV2",
  "deployment-profile": "DeploymentProfile",
  "recording-manifest": "RecordingManifest",
  "mock-capture": "MockCapture",
  "mock-playback": "MockPlayback",
  "mock-tracks": "MockTracks",
};
const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../contracts/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  );

// この変換器は構造の型だけを生成する。数値・文字列の範囲、形式、条件、
// 重複の制約は、Ajvと実行時の意味検証で確認する。
function project(schema, root) {
  if (schema.$ref) {
    if (schema.$ref.startsWith("#/$defs/"))
      return project(root.$defs[schema.$ref.slice(8)], root);
    const name = schema.$ref.split("/").at(-1).replace(".schema.json", "");
    if (!names[name])
      throw new Error(`Unsupported type reference: ${schema.$ref}`);
    return names[name];
  }
  if ("const" in schema) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((x) => JSON.stringify(x)).join(" | ");
  if (schema.oneOf)
    return schema.oneOf.map((s) => `(${project(s, root)})`).join(" | ");
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return `Array<${project(schema.items, root)}>`;
  if (schema.type === "object") {
    const fields = Object.entries(schema.properties ?? {}).map(
      ([k, s]) =>
        `${JSON.stringify(k)}${schema.required?.includes(k) ? "" : "?"}: ${project(s, root)};`,
    );
    if (schema.additionalProperties !== false)
      fields.push("[key: string]: unknown;");
    return `{ ${fields.join("\n")} }`;
  }
  throw new Error(`Unsupported type shape: ${JSON.stringify(schema)}`);
}

let output =
  "// npm run generateによる自動生成。直接編集せず、実行時の制約はJSON Schemaで検証する。\n";
for (const [name, typeName] of Object.entries(names)) {
  const schema = read(name);
  output += `export type ${typeName} = ${project(schema, schema)};\n\n`;
}
for (const [name, typeName] of [
  ["node-payloads", "NodePayloadMap"],
  ["mock-requests", "MockRequestMap"],
  ["control", "ControlMap"],
]) {
  const schema = read(name);
  output += `export type ${typeName} = {\n${Object.entries(schema.$defs)
    .map(([k, s]) => `${JSON.stringify(k)}: ${project(s, schema)};`)
    .join("\n")}\n};\n`;
}
output +=
  'export type NodeEnvelope = { [K in keyof NodePayloadMap]: Omit<NodeEnvelopeBase, "type" | "payload"> & { type: K; payload: NodePayloadMap[K] } }[keyof NodePayloadMap];\n';
const target = fileURLToPath(
  new URL("../packages/contracts/generated.ts", import.meta.url),
);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output)
    throw new Error(
      "生成型が古い状態です。npm run generateを実行してください。",
    );
} else writeFileSync(target, output);
