// 合成チューナーから原本保存、模擬変換、認可済み再生要求までを検証する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BoundaryError, validate } from "../packages/contracts/index.ts";
import {
  FakeObjectStorage,
  mockGrant,
  sha256,
} from "../packages/storage/index.ts";
import type {
  MockGrant,
  StorageActor,
  ObjectReference,
} from "../packages/storage/index.ts";
import { MockApi } from "../apps/api/index.ts";
import {
  MockRepository,
  reconstruct,
  attemptPrefix,
} from "../apps/api/repository.ts";
import type { MockActor } from "../apps/api/repository.ts";
import { ingestMockCapture } from "../apps/api/capture.ts";
import { tunerFixture } from "../scripts/tuner-fixture.ts";
import { stateText, frontendStatus } from "../apps/web/index.ts";
import { scenario } from "./evidence.ts";

const actor: MockActor = {
  actorId: "user-demo-01",
  tenantId: "demo-household",
  roles: ["recorder", "viewer"],
};
const now = Date.parse("2026-10-29T00:00:30Z");
const ids = { recordingId: "rec-demo-01", attemptId: "attempt-demo-01" };
const request = JSON.stringify({ recordingId: ids.recordingId });
const encodeRequest = JSON.stringify({
  recordingId: ids.recordingId,
  jobId: "encode-demo-01",
});
const tracks: unknown = JSON.parse(
  readFileSync("tests/fixtures/tracks.json", "utf8"),
);
const hashes = (
  JSON.parse(readFileSync("tests/fixtures/synthetic-ts.json", "utf8")) as {
    expectedSha256: Record<string, string>;
  }
).expectedSha256;
const capture = tunerFixture("mirakurun");
const captureRaw = JSON.stringify(capture);

function setup(store = new FakeObjectStorage()) {
  const repository = new MockRepository();
  repository.create(actor, request);
  const api = new MockApi(repository, store);
  return { repository, store, api };
}
function ingest(
  repository: MockRepository,
  store: FakeObjectStorage,
  raw = captureRaw,
  attemptId = ids.attemptId,
) {
  return ingestMockCapture(
    actor,
    raw,
    { ...ids, attemptId },
    repository,
    store,
    tracks,
    now,
    4096,
  );
}

scenario(
  "CORE-01",
  "go-tuner-to-playback",
  "synthetic-ts-v1 + synthetic-tracks-v1",
  "両Mock・188/204から原本保存、模擬変換、認可済み再生要求まで完走する",
  () => {
    for (const backend of ["mirakurun", "mirakc"] as const)
      for (const packetSize of [188, 204] as const) {
        const fixture = tunerFixture(backend, packetSize);
        assert.equal(fixture.sourceStreamSha256, hashes[String(packetSize)]);
        assert.equal(fixture.programs.length, 1);
        assert.equal(fixture.services.length, 1);
        assert.equal(fixture.channels.length, 1);
        const { repository, store, api } = setup();
        assert.equal(api.playback(actor, request, now).state, "empty");
        const attempt = ingest(repository, store, JSON.stringify(fixture));
        repository.publishCanonical(actor, ids.recordingId, ids.attemptId, 0);
        assert.equal(api.playback(actor, request, now).state, "waiting");
        const originalGrant = mockGrant(
          actor,
          attemptPrefix(ids.recordingId, ids.attemptId),
          now,
        );
        const original = reconstruct(
          actor,
          originalGrant,
          attempt.manifest,
          store,
          now,
        );
        assert.deepEqual(original, Buffer.from(fixture.sourceBase64, "base64"));
        assert.equal(sha256(original), hashes[String(packetSize)]);
        const output = api.requestEncode(actor, encodeRequest, now);
        assert.ok(output);
        assert.deepEqual(api.requestEncode(actor, encodeRequest, now), output);
        assert.equal(output.playable, false);
        assert.equal(output.codecSupport, "not implemented");
        assert.ok(
          output.segments.every((s) => s.objectKey.startsWith("renditions/")),
        );
        assert.ok(output.preservedMetadata.objectKey.startsWith("recordings/"));
        assert.ok(output.captionSidecar.objectKey.startsWith("renditions/"));
        assert.ok(output.audioMetadata.objectKey.startsWith("renditions/"));
        const preserved = validate(
          "mock-tracks",
          JSON.parse(
            store
              .readVerified(actor, originalGrant, output.preservedMetadata, now)
              .toString(),
          ) as unknown,
        );
        assert.deepEqual(preserved, tracks);
        const response = api.playback(actor, request, now);
        assert.equal(response.state, "mock-ready");
        assert.deepEqual(
          reconstruct(actor, originalGrant, attempt.manifest, store, now),
          original,
        );
        const cloned = repository.attempt(
          actor,
          ids.recordingId,
          ids.attemptId,
        );
        cloned.manifest.chunks.length = 0;
        assert.equal(
          repository.attempt(actor, ids.recordingId, ids.attemptId).manifest
            .chunks.length,
          4,
        );
      }
  },
);

scenario(
  "MED-01",
  "corrupt-duplicate-missing-chunks",
  "synthetic-ts-v1",
  "破損hash、重複順序、欠損、別attempt、パケット不整合を公開しない",
  () => {
    const { repository, store } = setup();
    const attempt = ingest(repository, store);
    const grant = mockGrant(
      actor,
      attemptPrefix(ids.recordingId, ids.attemptId),
      now,
    );
    for (const mutate of [
      (m: typeof attempt.manifest) => {
        m.chunks[1]!.sequence = 0;
      },
      (m: typeof attempt.manifest) => {
        m.chunks.pop();
      },
      (m: typeof attempt.manifest) => {
        m.chunks[0]!.sha256 = "0".repeat(64);
      },
      (m: typeof attempt.manifest) => {
        m.chunks[0]!.objectKey =
          "recordings/other/attempts/other/raw/000000.ts";
      },
      (m: typeof attempt.manifest) => {
        m.chunks[0]!.sizeBytes += 1;
      },
      (m: typeof attempt.manifest) => {
        m.chunks.reverse();
      },
      (m: typeof attempt.manifest) => {
        m.chunks = [];
      },
    ]) {
      const invalid = structuredClone(attempt.manifest);
      mutate(invalid);
      assert.throws(
        () =>
          repository.commitAttempt(
            actor,
            invalid,
            attempt.preservedMetadata,
            store,
            grant,
            now,
          ),
        BoundaryError,
      );
    }
    class FaultRead extends FakeObjectStorage {
      mode: "missing" | "corrupt" = "missing";
      override get(
        a: StorageActor,
        g: MockGrant,
        key: string,
        at: number,
      ): Buffer {
        if (key.endsWith("000001.ts")) {
          if (this.mode === "missing")
            throw new BoundaryError("MISSING_OBJECT", "故障注入", 404);
          const bytes = super.get(a, g, key, at);
          bytes[20] = bytes[20]! ^ 0xff;
          return bytes;
        }
        return super.get(a, g, key, at);
      }
    }
    const fault = new FaultRead();
    for (const part of capture.chunks)
      fault.putImmutable(
        actor,
        grant,
        `${grant.prefix}raw/${String(part.sequence).padStart(6, "0")}.ts`,
        Buffer.from(part.dataBase64, "base64"),
        part.sha256,
        part.sizeBytes,
        now,
      );
    assert.throws(
      () => reconstruct(actor, grant, attempt.manifest, fault, now),
      BoundaryError,
    );
    fault.mode = "corrupt";
    assert.throws(
      () => reconstruct(actor, grant, attempt.manifest, fault, now),
      BoundaryError,
    );
    const duplicate = structuredClone(capture);
    duplicate.chunks[1]!.sequence = 0;
    assert.throws(
      () => ingest(repository, store, JSON.stringify(duplicate)),
      BoundaryError,
    );
    const missing = structuredClone(capture);
    missing.chunks.pop();
    assert.throws(
      () => ingest(repository, store, JSON.stringify(missing)),
      BoundaryError,
    );
    assert.throws(
      () =>
        ingestMockCapture(
          actor,
          captureRaw,
          ids,
          repository,
          store,
          tracks,
          now,
          0,
        ),
      BoundaryError,
    );
  },
);

scenario(
  "CORE-01",
  "upload-and-encode-failure",
  "synthetic-ts-v1",
  "部分転送と変換失敗を成功にせず、有限の明示再試行で原本を保持する",
  () => {
    class FaultWrite extends FakeObjectStorage {
      failure: "upload" | "encode" | undefined = "upload";
      override putImmutable(
        a: StorageActor,
        g: MockGrant,
        key: string,
        bytes: Uint8Array,
        hash: string,
        length: number,
        at: number,
      ): ObjectReference {
        if (
          (this.failure === "upload" && key.endsWith("000001.ts")) ||
          (this.failure === "encode" && key.startsWith("renditions/"))
        )
          throw new BoundaryError(
            "INJECTED_FAILURE",
            "保存先へ接続できません。",
            503,
          );
        return super.putImmutable(a, g, key, bytes, hash, length, at);
      }
    }
    const store = new FaultWrite();
    const { repository, api } = setup(store);
    assert.throws(() => ingest(repository, store), BoundaryError);
    assert.throws(
      () => repository.attempt(actor, ids.recordingId, ids.attemptId),
      BoundaryError,
    );
    assert.equal(api.playback(actor, request, now).state, "empty");
    store.failure = undefined;
    const attempt = ingest(repository, store);
    assert.deepEqual(ingest(repository, store), attempt);
    repository.publishCanonical(actor, ids.recordingId, ids.attemptId, 0);
    store.failure = "encode";
    assert.throws(
      () => api.requestEncode(actor, encodeRequest, now),
      BoundaryError,
    );
    assert.equal(api.playback(actor, request, now).state, "waiting");
    assert.equal(
      reconstruct(
        actor,
        mockGrant(actor, attemptPrefix(ids.recordingId, ids.attemptId), now),
        attempt.manifest,
        store,
        now,
      ).length,
      2444,
    );
    store.failure = undefined;
    api.requestEncode(actor, encodeRequest, now);
    assert.equal(api.playback(actor, request, now).state, "mock-ready");
  },
);

scenario(
  "CORE-01",
  "mock-authorization-and-attempt-isolation",
  "synthetic-ts-v1",
  "別主体・別テナント・役割不足を拒否し、attemptを混ぜず、古いrevisionを公開しない",
  () => {
    const { repository, store, api } = setup();
    const first = ingest(repository, store);
    const second = ingest(repository, store, captureRaw, "attempt-demo-02");
    assert.notEqual(
      first.manifest.chunks[0]?.objectKey,
      second.manifest.chunks[0]?.objectKey,
    );
    repository.publishCanonical(actor, ids.recordingId, ids.attemptId, 0);
    assert.throws(
      () =>
        repository.publishCanonical(
          actor,
          ids.recordingId,
          "attempt-demo-02",
          0,
        ),
      BoundaryError,
    );
    for (const outsider of [
      { ...actor, actorId: "other-user" },
      { ...actor, tenantId: "other-tenant" },
      { ...actor, roles: [] },
    ]) {
      assert.throws(() => api.playback(outsider, request, now), BoundaryError);
      assert.throws(
        () => api.requestEncode(outsider, encodeRequest, now),
        BoundaryError,
      );
    }
    assert.throws(
      () =>
        api.requestEncode({ ...actor, roles: ["viewer"] }, encodeRequest, now),
      BoundaryError,
    );
    assert.throws(
      () =>
        api.playback(
          actor,
          JSON.stringify({
            recordingId: ids.recordingId,
            url: "https://example.test",
          }),
          now,
        ),
      BoundaryError,
    );
    assert.throws(
      () => api.playback(actor, " ".repeat(1025), now),
      BoundaryError,
    );
    api.requestEncode(actor, encodeRequest, now);
    repository.publishCanonical(actor, ids.recordingId, "attempt-demo-02", 1);
    assert.equal(api.playback(actor, request, now).state, "waiting");
    for (const state of [
      "empty",
      "waiting",
      "failed",
      "disconnected",
      "reconnecting",
      "forbidden",
    ] as const)
      assert.match(stateText[state], /[ぁ-んァ-ヶ一-龠]/);
    assert.match(frontendStatus.originIsolation, /別origin/);
    assert.match(frontendStatus.backendRecovery, /復旧を意味しません/);
  },
);
