// Workerでも使える生成済みのSchema検証器で、制御APIの入力を確認する。
import * as validators from "./runtime.mjs";
import type { ControlMap } from "../contracts/generated.ts";
import { BoundaryError } from "../contracts/error.ts";

export type { ControlMap } from "../contracts/generated.ts";
// JSON化できない値、過大入力、Schemaにない項目を拒否してから型を確定する。
export function validateControl<K extends keyof ControlMap>(
  kind: K,
  value: unknown,
): ControlMap[K] {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(value);
  } catch {
    /* JSONへ変換できない入力は、後続の条件で拒否する。 */
  }
  if (raw === undefined || new TextEncoder().encode(raw).byteLength > 16_384)
    throw new BoundaryError(
      "INVALID_INPUT",
      "データの形式またはサイズを確認してください。",
      400,
    );
  if (!validators[kind](value))
    throw new BoundaryError(
      "INVALID_SCHEMA",
      "データの項目または形式を確認してください。",
      400,
    );
  return value as ControlMap[K];
}
