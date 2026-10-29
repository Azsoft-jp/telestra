// メモリ内のオブジェクトに認可と容量制限を適用し、保存済みバイトの上書きを防ぐ。
import { createHash } from "node:crypto";
import { BoundaryError } from "../contracts/index.ts";
import type { MockPlayback } from "../contracts/generated.ts";

export type ObjectReference = MockPlayback["preservedMetadata"];
export interface StorageActor {
  tenantId: string;
  actorId: string;
}
type Method = "put" | "get" | "stat";
export interface MockGrant extends StorageActor {
  prefix: string;
  methods: readonly Method[];
  maxBytes: number;
  expiresAt: number;
}
// 保存と読取で同じhash表現を使い、バイト列の一致を照合する。
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const safeKey = (key: string): boolean =>
  /^(recordings|renditions)\/[A-Za-z0-9_./:-]+$/.test(key) &&
  key.length <= 1024 &&
  !key.split("/").some((part) => part === ".." || part === "." || part === "");

// 実Storageの通信や永続性を模倣せず、プロセス内の保存契約だけを検証する。
export class FakeObjectStorage {
  readonly capabilities = Object.freeze({
    rangeRead: false,
    conditionalWrite: true,
    multipartUpload: false,
    presignRead: false,
    presignWrite: false,
    atomicRename: false,
    append: false,
    consistency: "process-local" as const,
  });
  private objects = new Map<string, { bytes: Buffer; sha256: string }>();
  private totalBytes = 0;
  private limits: { maxObjectBytes: number; maxTotalBytes: number };
  constructor(
    limits = { maxObjectBytes: 1_048_576, maxTotalBytes: 8_388_608 },
  ) {
    if (
      !Number.isSafeInteger(limits.maxObjectBytes) ||
      !Number.isSafeInteger(limits.maxTotalBytes) ||
      limits.maxObjectBytes <= 0 ||
      limits.maxTotalBytes < limits.maxObjectBytes
    )
      throw new Error("Mock容量設定が不正です。");
    this.limits = { ...limits };
  }
  private authorize(
    actor: StorageActor,
    grant: MockGrant,
    key: string,
    method: Method,
    now: number,
  ): string {
    if (
      !/^[A-Za-z0-9_.:-]{3,128}$/.test(actor.tenantId) ||
      !/^[A-Za-z0-9_.:-]{3,128}$/.test(actor.actorId) ||
      actor.tenantId !== grant.tenantId ||
      actor.actorId !== grant.actorId ||
      !grant.methods.includes(method) ||
      !Number.isFinite(now) ||
      !Number.isFinite(grant.expiresAt) ||
      now >= grant.expiresAt ||
      !Number.isSafeInteger(grant.maxBytes) ||
      grant.maxBytes < 1 ||
      !safeKey(key) ||
      !grant.prefix.endsWith("/") ||
      !safeKey(grant.prefix.slice(0, -1)) ||
      !key.startsWith(grant.prefix)
    ) {
      throw new BoundaryError(
        "FORBIDDEN_STORAGE",
        "保存先への操作が許可されていません。",
        403,
      );
    }
    return `${actor.tenantId}\0${key}`;
  }
  // 同一バイトの再送を許可し、内容の変更、破損、容量超過は保存前に拒否する。
  putImmutable(
    actor: StorageActor,
    grant: MockGrant,
    key: string,
    bytes: Uint8Array,
    hash: string,
    expectedLength: number,
    now: number,
  ): ObjectReference {
    const id = this.authorize(actor, grant, key, "put", now);
    if (
      !(bytes instanceof Uint8Array) ||
      !Number.isSafeInteger(expectedLength) ||
      expectedLength < 1 ||
      expectedLength !== bytes.byteLength ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new BoundaryError(
        "INVALID_OBJECT",
        "保存データの長さと形式を確認してください。",
      );
    if (bytes.byteLength > Math.min(grant.maxBytes, this.limits.maxObjectBytes))
      throw new BoundaryError(
        "TOO_LARGE",
        "保存データが上限を超えています。",
        413,
      );
    const copy = Buffer.from(bytes);
    if (sha256(copy) !== hash)
      throw new BoundaryError(
        "HASH_MISMATCH",
        "保存データが破損しています。再転送してください。",
        422,
      );
    const previous = this.objects.get(id);
    if (previous && (previous.sha256 !== hash || !previous.bytes.equals(copy)))
      throw new BoundaryError(
        "IMMUTABLE_CONFLICT",
        "保存済みの原本は上書きできません。",
        409,
      );
    if (!previous) {
      if (this.totalBytes + copy.length > this.limits.maxTotalBytes)
        throw new BoundaryError(
          "STORAGE_FULL",
          "保存容量が不足しています。",
          507,
        );
      this.objects.set(id, { bytes: copy, sha256: hash });
      this.totalBytes += copy.length;
    }
    return { objectKey: key, sha256: hash, sizeBytes: copy.length };
  }
  // 権限と読取上限を照合し、呼出元へは内部バイト列の複製を返す。
  get(actor: StorageActor, grant: MockGrant, key: string, now: number): Buffer {
    const id = this.authorize(actor, grant, key, "get", now);
    const object = this.objects.get(id);
    if (!object)
      throw new BoundaryError(
        "MISSING_OBJECT",
        "保存データが見つかりません。転送状況を確認してください。",
        404,
      );
    if (object.bytes.length > grant.maxBytes)
      throw new BoundaryError(
        "TOO_LARGE",
        "読取サイズが上限を超えています。",
        413,
      );
    return Buffer.from(object.bytes);
  }
  // 存在情報も認可の対象とし、別主体や範囲外のオブジェクトを公開しない。
  stat(
    actor: StorageActor,
    grant: MockGrant,
    key: string,
    now: number,
  ): ObjectReference {
    const id = this.authorize(actor, grant, key, "stat", now);
    const object = this.objects.get(id);
    if (!object)
      throw new BoundaryError(
        "MISSING_OBJECT",
        "保存データが見つかりません。",
        404,
      );
    if (object.bytes.length > grant.maxBytes)
      throw new BoundaryError(
        "TOO_LARGE",
        "読取サイズが上限を超えています。",
        413,
      );
    return {
      objectKey: key,
      sha256: object.sha256,
      sizeBytes: object.bytes.length,
    };
  }
  // マニフェスト掲載値と保存バイトの長さ・hashが一致しない場合は失敗にする。
  readVerified(
    actor: StorageActor,
    grant: MockGrant,
    ref: ObjectReference,
    now: number,
  ): Buffer {
    const bytes = this.get(actor, grant, ref.objectKey, now);
    if (bytes.length !== ref.sizeBytes || sha256(bytes) !== ref.sha256)
      throw new BoundaryError(
        "CORRUPT_OBJECT",
        "保存データの整合性を確認できません。",
        422,
      );
    return bytes;
  }
}

// 開発用のプロセス内権限を作る。署名付きの資格情報は発行しない。
export function mockGrant(
  actor: StorageActor,
  prefix: string,
  now: number,
): MockGrant {
  return {
    ...actor,
    prefix,
    methods: ["put", "get", "stat"],
    maxBytes: 1_048_576,
    expiresAt: now + 60_000,
  };
}
