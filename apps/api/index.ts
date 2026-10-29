// 開発用の主体を使い、模擬変換の要求と再生マニフェストの取得を検証する。
import { parseRequest, validate } from "../../packages/contracts/index.ts";
import type { MockPlayback } from "../../packages/contracts/generated.ts";
import { FakeObjectStorage, mockGrant } from "../../packages/storage/index.ts";
import { MockEncodeNode } from "../../nodes/encoder/index.ts";
import { MockRepository, requireRole } from "./repository.ts";
import type { MockActor } from "./repository.ts";

export type PlaybackResponse =
  | { state: "empty" | "waiting"; message: string }
  | { state: "mock-ready"; message: string; manifest: MockPlayback };

// プロセス内だけで使う。呼出元が渡すMockActorは実際の認証情報ではない。
export class MockApi {
  repository: MockRepository;
  store: FakeObjectStorage;
  constructor(repository: MockRepository, store: FakeObjectStorage) {
    this.repository = repository;
    this.store = store;
  }
  // 認可された録画の模擬変換を要求し、原本がなければ未処理のまま返す。
  requestEncode(
    actor: MockActor,
    raw: string,
    now: number,
  ): MockPlayback | undefined {
    requireRole(actor, "recorder");
    const request = parseRequest("encode", raw);
    return new MockEncodeNode().encode(
      actor,
      request.recordingId,
      request.jobId,
      this.repository,
      this.store,
      now,
    );
  }
  // 保存済み派生物を再検証し、原本なし・変換待ち・模擬完了を区別して返す。
  playback(actor: MockActor, raw: string, now: number): PlaybackResponse {
    requireRole(actor, "viewer");
    const { recordingId } = parseRequest("playback", raw);
    const source = this.repository.canonical(actor, recordingId);
    if (!source)
      return {
        state: "empty",
        message:
          "保存済みの原本はありません。録画の転送状況を確認してください。",
      };
    const manifest = this.repository.rendition(actor, recordingId);
    if (!manifest)
      return {
        state: "waiting",
        message: "録画は保存済みです。再生用の映像を準備しています。",
      };
    validate("mock-playback", manifest);
    const grant = mockGrant(
      actor,
      `renditions/${recordingId}/${manifest.renditionId}/`,
      now,
    );
    for (const ref of [
      ...manifest.segments,
      manifest.captionSidecar,
      manifest.audioMetadata,
    ])
      this.store.readVerified(actor, grant, ref, now);
    return {
      state: "mock-ready",
      message: "模擬変換の結果を取得しました。実際の映像再生は未実装です。",
      manifest,
    };
  }
}
