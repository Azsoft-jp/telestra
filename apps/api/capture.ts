// 合成原本を検証し、保存済みのチャンクと付随情報だけを録画台帳へ登録する。
import {
  BoundaryError,
  boundedJson,
  validate,
} from "../../packages/contracts/index.ts";
import type { RecordingManifest } from "../../packages/contracts/generated.ts";
import {
  FakeObjectStorage,
  mockGrant,
  sha256,
} from "../../packages/storage/index.ts";
import { MockRepository, attemptPrefix, requireRole } from "./repository.ts";
import type { MockActor, Attempt } from "./repository.ts";

function decode(raw: string): Buffer {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.toString("base64") !== raw)
    throw new BoundaryError("INVALID_BASE64", "合成データの形式が不正です。");
  return bytes;
}
// 全チャンクの長さ・hash・順序と一時容量を確認してから、原本と付随情報を保存する。
export function ingestMockCapture(
  actor: MockActor,
  raw: string,
  ids: { recordingId: string; attemptId: string },
  repository: MockRepository,
  store: FakeObjectStorage,
  tracks: unknown,
  now: number,
  spoolMaxBytes: number,
): Attempt {
  requireRole(actor, "recorder");
  const capture = validate("mock-capture", boundedJson(raw, 2_097_152));
  const metadata = Buffer.from(JSON.stringify(validate("mock-tracks", tracks)));
  const source = decode(capture.sourceBase64);
  if (!Number.isSafeInteger(spoolMaxBytes) || spoolMaxBytes < source.length)
    throw new BoundaryError(
      "SPOOL_FULL",
      "録画の一時保存容量が不足しています。",
      507,
    );
  if (
    source.length === 0 ||
    source.length > 1_048_576 ||
    source.length % capture.packetSize !== 0 ||
    sha256(source) !== capture.sourceStreamSha256
  )
    throw new BoundaryError(
      "INVALID_SOURCE",
      "合成原本の整合性を確認できません。",
      422,
    );
  for (let i = 0; i < source.length; i += capture.packetSize)
    if (source[i] !== 0x47)
      throw new BoundaryError("INVALID_SYNC", "原本の同期バイトが不正です。");
  const buffers = capture.chunks.map((chunk, index) => {
    const bytes = decode(chunk.dataBase64);
    if (
      chunk.sequence !== index ||
      chunk.sizeBytes !== bytes.length ||
      bytes.length % capture.packetSize !== 0 ||
      sha256(bytes) !== chunk.sha256
    )
      throw new BoundaryError(
        "INVALID_CHUNK",
        "原本の順序、長さ、整合性を確認してください。",
        422,
      );
    return bytes;
  });
  if (!Buffer.concat(buffers).equals(source))
    throw new BoundaryError(
      "MISSING_CHUNK",
      "原本の一部が不足しています。",
      422,
    );
  const prefix = attemptPrefix(ids.recordingId, ids.attemptId);
  const manifest: RecordingManifest = {
    schemaVersion: 1,
    tenantId: actor.tenantId,
    ...ids,
    captureGeneration: 1,
    source: {
      nodeId: "tuner-demo-01",
      backendId: capture.backend,
      serviceKey: "service-demo-01",
      captureScope: "service-filtered",
      packetSize: capture.packetSize,
      filterDescription: "合成データのみ。実放送・実Codecは未検証。",
    },
    status: "completed",
    createdAt: new Date(now).toISOString(),
    endedAt: new Date(now).toISOString(),
    sourceStreamSha256: capture.sourceStreamSha256,
    chunks: capture.chunks.map((chunk) => ({
      sequence: chunk.sequence,
      objectKey: `${prefix}raw/${String(chunk.sequence).padStart(6, "0")}.ts`,
      sizeBytes: chunk.sizeBytes,
      sha256: chunk.sha256,
      timelineEpoch: 0,
    })),
    warnings: [
      "Mockの保存契約検証です。実際の映像・字幕・音声処理は未実装です。",
    ],
  };
  validate("recording-manifest", manifest);
  repository.recording(actor, ids.recordingId);
  const grant = mockGrant(actor, prefix, now);
  // チャンクの到着順は問わず、公開時にマニフェストの順序を検証する。
  for (let i = buffers.length - 1; i >= 0; i--) {
    const chunk = manifest.chunks[i];
    const data = buffers[i];
    if (!chunk || !data)
      throw new Error("Mock内部のチャンクが不足しています。");
    store.putImmutable(
      actor,
      grant,
      chunk.objectKey,
      data,
      chunk.sha256,
      chunk.sizeBytes,
      now,
    );
  }
  const preservedMetadata = store.putImmutable(
    actor,
    grant,
    `${prefix}preserved/tracks.json`,
    metadata,
    sha256(metadata),
    metadata.length,
    now,
  );
  return repository.commitAttempt(
    actor,
    manifest,
    preservedMetadata,
    store,
    grant,
    now,
  );
}
