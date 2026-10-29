// ローカルMockの縦方向の検証を共有する。実サービスと再生可能な媒体は扱わない。
import { readFileSync, statSync } from "node:fs";
import {
  BoundaryError,
  boundedJson,
  validate,
  parseEnvelope,
} from "../packages/contracts/index.ts";
import {
  FakeObjectStorage,
  mockGrant,
  sha256,
} from "../packages/storage/index.ts";
import {
  MockRepository,
  reconstruct,
  attemptPrefix,
} from "../apps/api/repository.ts";
import type { MockActor } from "../apps/api/repository.ts";
import { ingestMockCapture } from "../apps/api/capture.ts";
import { MockApi } from "../apps/api/index.ts";
import { frontendStatus } from "../apps/web/index.ts";
import { tunerFixture } from "./tuner-fixture.ts";

// 固定した合成fixtureだけを処理し、外部プロファイルを実行前に拒否する。
export function runMock(profilePath: string, backend: string) {
  if (statSync(profilePath).size > 16_384)
    throw new BoundaryError("TOO_LARGE", "プロファイルが上限を超えています。");
  const profile = validate(
    "deployment-profile",
    boundedJson(readFileSync(profilePath, "utf8"), 16_384),
  );
  if (
    profile.environment !== "development" ||
    profile.controlPlane.provider !== "local" ||
    profile.recording.primaryStorage !== "local" ||
    profile.recording.secondaryStorage ||
    profile.frontend.redundancy !== "none" ||
    profile.features.liveStreaming ||
    profile.features.offlineLibrary
  )
    throw new BoundaryError(
      "NOT_IMPLEMENTED",
      "not implemented: この起動コマンドはローカルMock専用です。外部環境は起動できません。",
      501,
    );
  const origin = (raw: string): boolean => {
    const url = new URL(raw);
    return (
      url.origin === raw &&
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  };
  if (
    !origin(profile.controlPlane.apiOrigin) ||
    !origin(profile.frontend.primaryOrigin)
  )
    throw new BoundaryError(
      "INVALID_ORIGIN",
      "Mockにはローカルoriginを指定してください。",
    );
  if (backend !== "mirakurun" && backend !== "mirakc")
    throw new BoundaryError(
      "INVALID_BACKEND",
      "対応するMockを指定してください。",
    );
  const now = Date.parse("2026-10-29T00:00:30Z");
  const hello = validate(
    "node-envelope",
    JSON.parse(readFileSync("examples/node.hello.json", "utf8")) as unknown,
  );
  parseEnvelope(JSON.stringify(hello), {
    nodeId: "tuner-demo-01",
    sessionEpoch: 1,
    now,
    allowedTypes: ["node.hello"],
  });
  const actor: MockActor = {
    tenantId: "demo-household",
    actorId: "user-demo-01",
    roles: ["recorder", "viewer"],
  };
  const ids = { recordingId: "rec-demo-01", attemptId: "attempt-demo-01" };
  const request = JSON.stringify({ recordingId: ids.recordingId });
  const store = new FakeObjectStorage();
  const repository = new MockRepository();
  const api = new MockApi(repository, store);
  repository.create(actor, request);
  const fixture = tunerFixture(backend);
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
    profile.recording.spoolMaxBytes,
  );
  repository.publishCanonical(actor, ids.recordingId, ids.attemptId, 0);
  const waiting = api.playback(actor, request, now);
  if (profile.features.postEncode)
    api.requestEncode(
      actor,
      JSON.stringify({ recordingId: ids.recordingId, jobId: "encode-demo-01" }),
      now,
    );
  const response = api.playback(actor, request, now);
  const reconstructed = reconstruct(
    actor,
    mockGrant(actor, attemptPrefix(ids.recordingId, ids.attemptId), now),
    attempt.manifest,
    store,
    now,
  );
  return {
    mode: "Phase 00 local mock",
    fixtureId: fixture.fixtureId,
    backend: fixture.backend,
    clock: new Date(now).toISOString(),
    sourceBytes: reconstructed.length,
    sourceSha256: sha256(reconstructed),
    chunks: attempt.manifest.chunks.length,
    beforeEncode: waiting,
    playback: response,
    frontend: frontendStatus,
    persistence: "not implemented",
    authentication: "not implemented",
  };
}
