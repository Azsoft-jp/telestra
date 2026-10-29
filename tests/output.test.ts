// 不足・破損した変換物の公開を拒否し、原本が保持されることを確認する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BoundaryError } from "../packages/contracts/index.ts";
import {
  FakeObjectStorage,
  mockGrant,
  sha256,
} from "../packages/storage/index.ts";
import type { MockGrant, StorageActor } from "../packages/storage/index.ts";
import {
  MockRepository,
  reconstruct,
  attemptPrefix,
} from "../apps/api/repository.ts";
import type { MockActor } from "../apps/api/repository.ts";
import { ingestMockCapture } from "../apps/api/capture.ts";
import { MockApi } from "../apps/api/index.ts";
import { MockEncodeNode } from "../nodes/encoder/index.ts";
import { tunerFixture } from "../scripts/tuner-fixture.ts";
import { scenario } from "./evidence.ts";

scenario(
  "CORE-01",
  "derived-output-verification",
  "synthetic-ts-v1",
  "未検証の変換結果と不足・破損した再生物を拒否し、原本を保持する",
  () => {
    class ReadFault extends FakeObjectStorage {
      corrupt = false;
      override get(
        actor: StorageActor,
        grant: MockGrant,
        key: string,
        now: number,
      ): Buffer {
        const bytes = super.get(actor, grant, key, now);
        if (this.corrupt && key.endsWith("captions.mock.json")) bytes[0] = 0;
        return bytes;
      }
    }
    const actor: MockActor = {
      actorId: "user-demo-01",
      tenantId: "demo-household",
      roles: ["viewer", "recorder"],
    };
    const now = Date.parse("2026-10-29T00:00:30Z");
    const ids = { recordingId: "rec-demo-01", attemptId: "attempt-demo-01" };
    const request = JSON.stringify({ recordingId: ids.recordingId });
    const store = new ReadFault();
    const repository = new MockRepository();
    const api = new MockApi(repository, store);
    repository.create(actor, request);
    const fixture = tunerFixture("mirakurun");
    const tracks: unknown = JSON.parse(
      readFileSync("tests/fixtures/tracks.json", "utf8"),
    );
    const attempt = ingestMockCapture(
      actor,
      JSON.stringify(fixture),
      ids,
      repository,
      store,
      tracks,
      now,
      4096,
    );
    repository.publishCanonical(actor, ids.recordingId, ids.attemptId, 0);
    assert.throws(
      () =>
        new MockEncodeNode().encode(
          { ...actor, roles: ["viewer"] },
          ids.recordingId,
          "job-viewer-01",
          repository,
          store,
          now,
        ),
      BoundaryError,
    );
    const output = api.requestEncode(
      actor,
      JSON.stringify({ recordingId: ids.recordingId, jobId: "job-demo-01" }),
      now,
    );
    assert.ok(output);
    const invalid = structuredClone(output);
    invalid.segments[0]!.sha256 = "0".repeat(64);
    assert.throws(
      () => repository.registerRendition(actor, invalid, store, now),
      BoundaryError,
    );
    const absent = structuredClone(output);
    absent.segments[0]!.objectKey = `renditions/${ids.recordingId}/${output.renditionId}/absent.mock`;
    assert.throws(
      () => repository.registerRendition(actor, absent, store, now),
      BoundaryError,
    );
    store.corrupt = true;
    assert.throws(() => api.playback(actor, request, now), BoundaryError);
    assert.equal(
      sha256(
        reconstruct(
          actor,
          mockGrant(actor, attemptPrefix(ids.recordingId, ids.attemptId), now),
          attempt.manifest,
          store,
          now,
        ),
      ),
      fixture.sourceStreamSha256,
    );
    store.corrupt = false;
    assert.equal(api.playback(actor, request, now).state, "mock-ready");
  },
);
