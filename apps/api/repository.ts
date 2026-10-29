// 録画と試行を分けてメモリに保存し、検証済みの原本と変換結果を公開する。
import {
  BoundaryError,
  validate,
  boundedJson,
  parseRequest,
} from "../../packages/contracts/index.ts";
import type {
  RecordingManifest,
  MockPlayback,
} from "../../packages/contracts/generated.ts";
import {
  FakeObjectStorage,
  sha256,
  mockGrant,
} from "../../packages/storage/index.ts";
import type {
  StorageActor,
  MockGrant,
  ObjectReference,
} from "../../packages/storage/index.ts";

export interface MockActor extends StorageActor {
  roles: readonly ("viewer" | "recorder")[];
}
export interface Attempt {
  manifest: RecordingManifest;
  manifestSha256: string;
  preservedMetadata: ObjectReference;
}
interface Recording {
  tenantId: string;
  ownerId: string;
  recordingId: string;
  revision: number;
  canonicalAttemptId?: string;
}

// 開発用主体のID形式と必要Roleを確認する。実際の認証の代用にはしない。
export function requireRole(
  actor: MockActor,
  role: "viewer" | "recorder",
): void {
  if (
    !/^[A-Za-z0-9_.:-]{3,128}$/.test(actor.tenantId) ||
    !/^[A-Za-z0-9_.:-]{3,128}$/.test(actor.actorId) ||
    !actor.roles.includes(role)
  )
    throw new BoundaryError(
      "FORBIDDEN",
      "この操作を行う権限がありません。",
      403,
    );
}
// 試行ごとに保存先を分け、重複録画で既存の原本を上書きしない。
export const attemptPrefix = (recordingId: string, attemptId: string): string =>
  `recordings/${recordingId}/attempts/${attemptId}/`;

// 全体をメモリへ載せる復元処理は、1MiBまでの合成素材に制限する。
// 実際のメディア用Adapterでは、ストリームとして読み込む処理が必要になる。
export function reconstruct(
  actor: StorageActor,
  grant: MockGrant,
  manifest: RecordingManifest,
  store: FakeObjectStorage,
  now: number,
): Buffer {
  validate("recording-manifest", manifest);
  if (
    manifest.tenantId !== actor.tenantId ||
    manifest.chunks.length === 0 ||
    manifest.chunks.length > 64
  )
    throw new BoundaryError(
      "INVALID_MANIFEST",
      "原本のチャンク情報を確認してください。",
    );
  const prefix = attemptPrefix(manifest.recordingId, manifest.attemptId);
  let total = 0;
  const buffers = manifest.chunks.map((chunk, index) => {
    if (
      chunk.sequence !== index ||
      chunk.objectKey !== `${prefix}raw/${String(index).padStart(6, "0")}.ts` ||
      chunk.sizeBytes % manifest.source.packetSize !== 0
    )
      throw new BoundaryError(
        "INVALID_SEQUENCE",
        "原本の順序または境界が不正です。",
      );
    total += chunk.sizeBytes;
    if (total > 1_048_576)
      throw new BoundaryError(
        "TOO_LARGE",
        "Mock原本のサイズ上限を超えています。",
        413,
      );
    return store.readVerified(actor, grant, chunk, now);
  });
  const bytes = Buffer.concat(buffers);
  for (
    let offset = 0;
    offset < bytes.length;
    offset += manifest.source.packetSize
  ) {
    if (bytes[offset] !== 0x47)
      throw new BoundaryError("INVALID_SYNC", "原本の同期バイトが不正です。");
  }
  if (
    manifest.status === "completed" &&
    sha256(bytes) !== manifest.sourceStreamSha256
  )
    throw new BoundaryError(
      "SOURCE_MISMATCH",
      "原本全体の整合性を確認できません。",
      422,
    );
  return bytes;
}

// 台帳はプロセス内だけで保持する。再起動後の永続性は保証しない。
export class MockRepository {
  private recordings = new Map<string, Recording>();
  private attempts = new Map<string, Attempt>();
  private renditions = new Map<string, MockPlayback>();
  private key(actor: StorageActor, recordingId: string): string {
    return `${actor.tenantId}\0${recordingId}`;
  }
  // 同じ所有者の再送は既存録画を保ち、件数上限を超える新規作成を拒否する。
  create(actor: MockActor, raw: string): void {
    requireRole(actor, "recorder");
    const { recordingId } = parseRequest("playback", raw);
    const key = this.key(actor, recordingId);
    const existing = this.recordings.get(key);
    if (existing) {
      this.recording(actor, recordingId);
      return;
    }
    if (this.recordings.size >= 128)
      throw new BoundaryError("QUOTA", "Mockの録画件数上限に達しました。", 507);
    this.recordings.set(key, {
      tenantId: actor.tenantId,
      ownerId: actor.actorId,
      recordingId,
      revision: 0,
    });
  }
  // 別家庭・別所有者の台帳を返さず、返却値の変更が内部状態へ及ばないよう複製する。
  recording(actor: MockActor, recordingId: string): Recording {
    requireRole(
      actor,
      actor.roles.includes("recorder") ? "recorder" : "viewer",
    );
    const record = this.recordings.get(this.key(actor, recordingId));
    if (!record || record.ownerId !== actor.actorId)
      throw new BoundaryError(
        "FORBIDDEN_RECORDING",
        "この録画を利用できません。",
        403,
      );
    return structuredClone(record);
  }
  // 原本と付随情報の検証が済んだ試行だけを登録し、異なる内容の再送を拒否する。
  commitAttempt(
    actor: MockActor,
    input: unknown,
    metadata: ObjectReference,
    store: FakeObjectStorage,
    grant: MockGrant,
    now: number,
  ): Attempt {
    requireRole(actor, "recorder");
    const manifest = structuredClone(validate("recording-manifest", input));
    this.recording(actor, manifest.recordingId);
    if (
      manifest.tenantId !== actor.tenantId ||
      manifest.status !== "completed" ||
      !Number.isSafeInteger(manifest.captureGeneration)
    )
      throw new BoundaryError("INCOMPLETE", "原本の保存完了を確認できません。");
    reconstruct(actor, grant, manifest, store, now);
    if (
      metadata.objectKey !==
      `${attemptPrefix(manifest.recordingId, manifest.attemptId)}preserved/tracks.json`
    )
      throw new BoundaryError(
        "INVALID_METADATA",
        "原本付随情報の保存先が不正です。",
      );
    validate(
      "mock-tracks",
      boundedJson(
        store.readVerified(actor, grant, metadata, now).toString("utf8"),
        16_384,
      ),
    );
    const result = {
      manifest,
      manifestSha256: sha256(JSON.stringify(manifest)),
      preservedMetadata: structuredClone(metadata),
    };
    const key = `${this.key(actor, manifest.recordingId)}\0${manifest.attemptId}`;
    const previous = this.attempts.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(result))
      throw new BoundaryError(
        "ATTEMPT_CONFLICT",
        "保存済みの録画試行は上書きできません。",
        409,
      );
    if (!previous && this.attempts.size >= 256)
      throw new BoundaryError("QUOTA", "Mockの録画試行上限に達しました。", 507);
    this.attempts.set(key, result);
    return structuredClone(result);
  }
  attempt(actor: MockActor, recordingId: string, attemptId: string): Attempt {
    this.recording(actor, recordingId);
    const attempt = this.attempts.get(
      `${this.key(actor, recordingId)}\0${attemptId}`,
    );
    if (!attempt)
      throw new BoundaryError(
        "MISSING_ATTEMPT",
        "保存済みの録画試行がありません。",
        404,
      );
    return structuredClone(attempt);
  }
  // 取得時のrevisionと一致する場合だけ公開対象を更新し、古い更新を拒否する。
  publishCanonical(
    actor: MockActor,
    recordingId: string,
    attemptId: string,
    expectedRevision: number,
  ): void {
    requireRole(actor, "recorder");
    const record = this.recording(actor, recordingId);
    this.attempt(actor, recordingId, attemptId);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision !== record.revision
    )
      throw new BoundaryError(
        "STALE_REVISION",
        "録画情報が更新されています。再取得してください。",
        409,
      );
    this.recordings.set(this.key(actor, recordingId), {
      ...record,
      revision: record.revision + 1,
      canonicalAttemptId: attemptId,
    });
  }
  canonical(actor: MockActor, recordingId: string): Attempt | undefined {
    const record = this.recording(actor, recordingId);
    return record.canonicalAttemptId
      ? this.attempt(actor, recordingId, record.canonicalAttemptId)
      : undefined;
  }
  // 現在の原本と保存済みの派生物を照合し、古い原本からの結果を公開しない。
  registerRendition(
    actor: MockActor,
    input: unknown,
    store: FakeObjectStorage,
    now: number,
  ): void {
    requireRole(actor, "recorder");
    const value = structuredClone(validate("mock-playback", input));
    const canonical = this.canonical(actor, value.recordingId);
    if (
      !canonical ||
      canonical.manifest.attemptId !== value.attemptId ||
      canonical.manifestSha256 !== value.sourceManifestSha256 ||
      JSON.stringify(canonical.preservedMetadata) !==
        JSON.stringify(value.preservedMetadata)
    )
      throw new BoundaryError(
        "STALE_SOURCE",
        "変換元の録画が更新されています。",
        409,
      );
    const prefix = `renditions/${value.recordingId}/${value.renditionId}/`;
    if (
      ![...value.segments, value.captionSidecar, value.audioMetadata].every(
        (ref) => ref.objectKey.startsWith(prefix),
      )
    )
      throw new BoundaryError(
        "INVALID_RENDITION",
        "再生用データの保存先が不正です。",
      );
    const key = this.key(actor, value.recordingId);
    const grant = mockGrant(actor, prefix, now);
    for (const ref of [
      ...value.segments,
      value.captionSidecar,
      value.audioMetadata,
    ])
      store.readVerified(actor, grant, ref, now);
    const previous = this.renditions.get(key);
    if (
      previous?.renditionId === value.renditionId &&
      JSON.stringify(previous) !== JSON.stringify(value)
    )
      throw new BoundaryError(
        "RENDITION_CONFLICT",
        "保存済みの変換結果は上書きできません。",
        409,
      );
    this.renditions.set(key, value);
  }
  rendition(actor: MockActor, recordingId: string): MockPlayback | undefined {
    this.recording(actor, recordingId);
    const value = this.renditions.get(this.key(actor, recordingId));
    const canonical = this.canonical(actor, recordingId);
    return value && value.sourceManifestSha256 === canonical?.manifestSha256
      ? structuredClone(value)
      : undefined;
  }
}
