// 原本を保持したまま模擬変換物を作成し、検証後だけ再生用の台帳へ登録する。
import {
  boundedJson,
  validate,
  parseRequest,
} from "../../packages/contracts/index.ts";
import {
  FakeObjectStorage,
  mockGrant,
  sha256,
} from "../../packages/storage/index.ts";
import {
  MockRepository,
  reconstruct,
  attemptPrefix,
  requireRole,
} from "../../apps/api/repository.ts";
import type { MockActor } from "../../apps/api/repository.ts";
import type { MockPlayback } from "../../packages/contracts/generated.ts";

// 実Codecは扱わず、原本と派生物の分離および公開前の検証だけを模擬する。
export class MockEncodeNode {
  encode(
    actor: MockActor,
    recordingId: string,
    jobId: string,
    repository: MockRepository,
    store: FakeObjectStorage,
    now: number,
  ): MockPlayback | undefined {
    requireRole(actor, "recorder");
    parseRequest("encode", JSON.stringify({ recordingId, jobId }));
    const source = repository.canonical(actor, recordingId);
    if (!source) return undefined;
    const readGrant = mockGrant(
      actor,
      attemptPrefix(recordingId, source.manifest.attemptId),
      now,
    );
    reconstruct(actor, readGrant, source.manifest, store, now);
    const tracks = validate(
      "mock-tracks",
      boundedJson(
        store
          .readVerified(actor, readGrant, source.preservedMetadata, now)
          .toString("utf8"),
        16_384,
      ),
    );
    const renditionId = `mock-${sha256(`${source.manifestSha256}:${jobId}`).slice(0, 24)}`;
    const prefix = `renditions/${recordingId}/${renditionId}/`;
    const writeGrant = mockGrant(actor, prefix, now);
    const write = (name: string, bytes: Buffer) =>
      store.putImmutable(
        actor,
        writeGrant,
        `${prefix}${name}`,
        bytes,
        sha256(bytes),
        bytes.length,
        now,
      );
    const segments = source.manifest.chunks.map((chunk) =>
      write(
        `${chunk.sequence}.mock`,
        Buffer.from(`MOCK ONLY; NOT A CODEC\n${chunk.sha256}\n`),
      ),
    );
    const value = validate("mock-playback", {
      schemaVersion: 1,
      kind: "mock-playback",
      playable: false,
      codecSupport: "not implemented",
      recordingId,
      attemptId: source.manifest.attemptId,
      renditionId,
      sourceManifestSha256: source.manifestSha256,
      preservedMetadata: source.preservedMetadata,
      segments,
      captionSidecar: write(
        "captions.mock.json",
        Buffer.from(JSON.stringify(tracks.captions)),
      ),
      audioMetadata: write(
        "audio.mock.json",
        Buffer.from(JSON.stringify(tracks.audio)),
      ),
    });
    // 保存結果の長さとhashを検証してから、再生用の台帳へ登録する。
    for (const ref of [
      ...value.segments,
      value.captionSidecar,
      value.audioMetadata,
    ])
      store.readVerified(actor, writeGrant, ref, now);
    repository.registerRendition(actor, value, store, now);
    return value;
  }
}
