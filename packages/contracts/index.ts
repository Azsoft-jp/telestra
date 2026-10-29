// JSON Schemaと実行時の制限を組み合わせ、契約を越える入力を拒否する。
import { readFileSync, readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type {
  CapturePermit,
  DeploymentProfile,
  MockCapture,
  MockPlayback,
  MockTracks,
  MockRequestMap,
  NodeEnvelope,
  NodeEnvelopeBase,
  RecordingManifest,
} from "./generated.ts";

export type * from "./generated.ts";

import { BoundaryError } from "./error.ts";
export { BoundaryError } from "./error.ts";

const base = "https://schema.example.test/tv/v1/";
const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  strictRequired: false,
  allErrors: false,
});
for (const [name, format] of Object.entries(fullFormats))
  ajv.addFormat(name, format);
const directory = new URL("../../contracts/", import.meta.url);
for (const file of readdirSync(directory).filter((f) =>
  f.endsWith(".schema.json"),
)) {
  ajv.addSchema(
    JSON.parse(readFileSync(new URL(file, directory), "utf8")) as object,
  );
}
// 未使用のドラフトも含めてSchemaをコンパイルする。外部の参照先は取得しない。
for (const file of readdirSync(directory).filter((f) =>
  f.endsWith(".schema.json"),
)) {
  if (!ajv.getSchema(base + file))
    throw new Error("スキーマを読み込めません。");
}

interface SchemaTypes {
  "node-envelope": NodeEnvelopeBase;
  "capture-permit": CapturePermit;
  "deployment-profile": DeploymentProfile;
  "recording-manifest": RecordingManifest;
  "mock-capture": MockCapture;
  "mock-playback": MockPlayback;
  "mock-tracks": MockTracks;
}

// UTF-8のバイト数を確認してから解析し、過大入力を拒否する。
export function boundedJson(raw: string, maxBytes: number): unknown {
  if (Buffer.byteLength(raw, "utf8") > maxBytes)
    throw new BoundaryError("TOO_LARGE", "データが上限を超えています。", 413);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BoundaryError("INVALID_JSON", "データの形式を確認してください。");
  }
}

// JSON化できない値と、直列化後に上限を超える値を拒否する。
export function assertSize(value: unknown, maxBytes: number): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    /* JSONへ変換できない入力は、直後の条件で拒否する。 */
  }
  if (serialized === undefined)
    throw new BoundaryError("INVALID_JSON", "データの形式を確認してください。");
  if (Buffer.byteLength(serialized, "utf8") > maxBytes)
    throw new BoundaryError("TOO_LARGE", "データが上限を超えています。", 413);
}

function schemaCheck(id: string, value: unknown): void {
  const check = ajv.getSchema(id);
  if (!check) throw new Error("未登録のスキーマです。");
  if (!check(value))
    throw new BoundaryError(
      "INVALID_SCHEMA",
      "データの項目または形式を確認してください。",
    );
}

// 型の宣言だけに頼らず、サイズと登録済みSchemaの両方を検証する。
export function validate<N extends keyof SchemaTypes>(
  name: N,
  value: unknown,
): SchemaTypes[N] {
  assertSize(value, name === "mock-capture" ? 2_097_152 : 1_048_576);
  schemaCheck(`${base}${name}.schema.json`, value);
  return value as SchemaTypes[N];
}

// Mockの操作種別に対応するpayloadだけを、1KiB以内で受け付ける。
export function parseRequest<K extends keyof MockRequestMap>(
  kind: K,
  raw: string,
): MockRequestMap[K] {
  const value = boundedJson(raw, 1024);
  schemaCheck(`${base}mock-requests.schema.json#/$defs/${kind}`, value);
  return value as MockRequestMap[K];
}

export interface NodeContext {
  nodeId: string;
  sessionEpoch: number;
  now: number;
  allowedTypes: readonly NodeEnvelope["type"][];
}

// payload、Node、接続世代、許可操作、期限を検証する。暗号署名はこの関数の対象外。
export function parseEnvelope(raw: string, context: NodeContext): NodeEnvelope {
  const envelope = validate("node-envelope", boundedJson(raw, 65_536));
  schemaCheck(
    `${base}node-payloads.schema.json#/$defs/${envelope.type}`,
    envelope.payload,
  );
  if (
    envelope.nodeId !== context.nodeId ||
    envelope.sessionEpoch !== context.sessionEpoch ||
    !context.allowedTypes.includes(envelope.type)
  ) {
    throw new BoundaryError(
      "FORBIDDEN_NODE",
      "このノードでは操作できません。",
      403,
    );
  }
  const issued = Date.parse(envelope.issuedAt);
  const expires = Date.parse(envelope.expiresAt);
  if (
    !Number.isFinite(context.now) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > context.now ||
    expires <= context.now ||
    expires <= issued ||
    expires - issued > 300_000
  ) {
    throw new BoundaryError("EXPIRED", "操作の有効期限を確認してください。");
  }
  return envelope as NodeEnvelope;
}
