// 未採用Schemaと合成モデルを検査する。DESIGNの成功を署名検証器・録画・SEC/RELの合格へ読み替えない。
import assert from "node:assert/strict";
import {
  generateKeyPair,
  SignJWT,
  compactVerify,
  decodeProtectedHeader,
} from "jose";
import example from "../docs/proposals/capture-permit-v2/example.json" with { type: "json" };
import { candidateOutcome, samplePolicy } from "./proposals/permit-model.ts";
import { validateControl } from "../packages/control-contracts/index.ts";
import { scenario } from "./evidence.ts";

scenario(
  "DESIGN-01",
  "permit-candidate-schema-and-inactive-runtime",
  "unsigned-capture-permit-proposal-v2",
  "必須binding・scope・数値境界を検査し、v2候補は現行v1のAPIに採用されない",
  () => {
    assert.equal(example.status, "proposed-not-adopted");
    assert.equal(example.runtimeEnabled, false);
    const policy = samplePolicy();
    assert.equal(candidateOutcome(example.claims, policy), "model-online");
    for (const key of Object.keys(example.claims)) {
      const value: Record<string, unknown> = structuredClone(example.claims);
      delete value[key];
      assert.equal(candidateOutcome(value, policy), "model-rejected", key);
    }
    for (const changed of [
      { schemaVersion: 1 },
      { nodeRole: "encoder" },
      { aud: "tv-api" },
      { exp: Number.MAX_SAFE_INTEGER + 1 },
      { exp: 1.5 },
      { spoolMaxBytes: -1 },
      { shell: "id" },
      { nodeId: "../other-node" },
      { captureScope: "automatic" },
    ])
      assert.equal(
        candidateOutcome({ ...example.claims, ...changed }, policy),
        "model-rejected",
      );
    assert.equal(candidateOutcome(" ".repeat(8193), policy), "model-rejected");
    assert.throws(() =>
      validateControl("WsCaptureStart", { permit: example.claims }),
    );
    assert.throws(() =>
      validateControl("DispatchCommand", {
        commandId: "proposal-command",
        type: "capture.start.v2",
        payload: { permitJws: "not-a-token" },
        expiresAt: "2026-10-29T00:01:00Z",
      }),
    );
  },
);

scenario(
  "DESIGN-02",
  "permit-candidate-policy-scope-and-generations",
  "trusted-policy-binding-proposal-v2",
  "家庭・環境・Node・割当・予約版と保存先を照合し、通常の資格更新は認可世代から分ける候補を検査する",
  () => {
    const policy = samplePolicy();
    assert.equal(
      candidateOutcome(example.claims, { ...policy, credentialVersion: 2 }),
      "model-online",
    );
    for (const changed of [
      { issuer: "http://control.example.invalid" },
      { issuer: "https://foreign.example.invalid" },
      { tenantId: "foreign-household" },
      { environment: "production" },
      { nodeId: "foreign-node" },
      { role: "encoder" as const },
      { authorizationEpoch: 4 },
      { assignmentEpoch: 9 },
      { reservationRevision: 3 },
      { recordingId: "foreign-recording" },
      { attemptId: "foreign-attempt" },
      { backendId: "foreign-backend" },
      { serviceKey: "foreign-service" },
      { captureScope: "multiplex" },
      { anchorKnown: false },
      { knownRevoked: true },
      { maxObservedTime: policy.now + 1 },
      { maxObservedTime: null },
      { spoolReservedBytes: example.claims.spoolMaxBytes - 1 },
      { maxPermitLifetimeSeconds: 3599 },
      { captureEarliest: example.claims.nbf + 1 },
      { captureLatest: example.claims.exp - 1 },
      { maxOfflineSeconds: 1799 },
      { now: Number.NaN },
    ])
      assert.equal(
        candidateOutcome(example.claims, { ...policy, ...changed }),
        "model-rejected",
      );
    for (const changed of [
      { scopeId: "foreign-scope" },
      { adapterId: "unconfigured-adapter" },
      { namespaceId: "foreign-namespace" },
      { tenantId: "foreign-household" },
      { environment: "production" },
      { nodeId: "foreign-node" },
      { recordingId: "foreign-recording" },
      { attemptId: "foreign-attempt" },
      { prefix: "canonical/" },
      { prefix: policy.scope.prefix + "../" },
      { method: "GET" },
      { purpose: "canonical-write" },
      { maxChunkBytes: policy.maxChunkBytes + 1 },
      { url: "https://foreign.example.invalid/upload" },
    ])
      assert.equal(
        candidateOutcome(example.claims, {
          ...policy,
          scope: { ...policy.scope, ...changed },
        }),
        "model-rejected",
      );
    const multiplex = { ...example.claims, captureScope: "multiplex" };
    const configured = { ...policy, captureScope: "multiplex" };
    assert.equal(candidateOutcome(multiplex, configured), "model-rejected");
    assert.equal(
      candidateOutcome(multiplex, { ...configured, allowMultiplex: true }),
      "model-online",
    );
  },
);

scenario(
  "DESIGN-03",
  "permit-candidate-offline-boundaries-and-split-brain",
  "bounded-offline-proposal-v2",
  "期限・スプール0・満杯を拒否し、分断中の二重録画可能性とattempt別prefixをモデルで区別する",
  () => {
    const policy = samplePolicy();
    const offline = { ...policy, controlOnline: false };
    assert.equal(candidateOutcome(example.claims, offline), "model-offline");
    assert.equal(
      candidateOutcome(example.claims, { ...policy, uploadAvailable: false }),
      "model-offline",
    );
    assert.equal(
      candidateOutcome(example.claims, {
        ...offline,
        now: example.claims.offlineAllowedUntil - 1,
      }),
      "model-offline",
    );
    assert.equal(
      candidateOutcome(example.claims, {
        ...offline,
        now: example.claims.offlineAllowedUntil,
      }),
      "model-rejected",
    );
    assert.equal(
      candidateOutcome(example.claims, {
        ...offline,
        spoolUsedBytes: example.claims.spoolMaxBytes,
      }),
      "model-rejected",
    );
    assert.equal(
      candidateOutcome({ ...example.claims, spoolMaxBytes: 0 }, offline),
      "model-rejected",
    );
    assert.equal(
      candidateOutcome({ ...example.claims, spoolMaxBytes: 0 }, policy),
      "model-online",
    );
    assert.equal(
      candidateOutcome(
        { ...example.claims, spoolMaxBytes: 0 },
        { ...policy, memoryUploadBytes: 0 },
      ),
      "model-rejected",
    );
    assert.equal(
      candidateOutcome(example.claims, { ...policy, now: example.claims.exp }),
      "model-rejected",
    );
    assert.equal(
      candidateOutcome(
        { ...example.claims, nbf: example.claims.nbf + 60 },
        policy,
      ),
      "model-waiting",
    );
    for (const changed of [
      { iat: policy.now + 1 },
      { nbf: example.claims.exp },
      { offlineAllowedUntil: example.claims.exp + 1 },
    ])
      assert.equal(
        candidateOutcome({ ...example.claims, ...changed }, policy),
        "model-rejected",
      );
    const second = {
      ...example.claims,
      jti: "permit-proposal-02",
      nodeId: "tuner-proposal-02",
      sub: "tuner-proposal-02",
      attemptId: "attempt-proposal-02",
      assignmentEpoch: 9,
      storageScopeId: "scope-proposal-02",
    };
    const secondPolicy = {
      ...offline,
      nodeId: second.nodeId,
      attemptId: second.attemptId,
      assignmentEpoch: second.assignmentEpoch,
      scope: {
        ...policy.scope,
        scopeId: second.storageScopeId,
        nodeId: second.nodeId,
        attemptId: second.attemptId,
        prefix: `recordings/${second.recordingId}/attempts/${second.attemptId}/`,
      },
    };
    assert.equal(candidateOutcome(second, secondPolicy), "model-offline");
    assert.equal(candidateOutcome(example.claims, offline), "model-offline");
    assert.notEqual(offline.scope.prefix, secondPolicy.scope.prefix);
    assert.equal(
      candidateOutcome(example.claims, { ...offline, assignmentEpoch: 9 }),
      "model-rejected",
    );
    // 許可期間を更新しても実行中attemptを変えない。再起動・再割当は別attemptとして扱う候補。
    const renewed = {
      ...example.claims,
      jti: "permit-proposal-renewed",
      assignmentEpoch: 9,
      iat: example.claims.iat + 900,
      nbf: example.claims.iat + 900,
      offlineAllowedUntil: example.claims.iat + 2700,
    };
    const renewedPolicy = {
      ...offline,
      assignmentEpoch: 9,
      now: renewed.iat + 1,
      maxObservedTime: renewed.iat,
    };
    assert.equal(candidateOutcome(renewed, renewedPolicy), "model-offline");
    assert.equal(renewed.attemptId, example.claims.attemptId);
    assert.equal(
      candidateOutcome(example.claims, renewedPolicy),
      "model-rejected",
    );
  },
);

scenario(
  "DESIGN-04",
  "permit-candidate-jws-algorithm-and-purpose-spike",
  "memory-only-ed25519-proposal-v2",
  "現在のjoseでEd25519 algを往復し、用途違い・改ざん・URL鍵ヘッダーを拒否する探索試験。製品の検証器ではない",
  async () => {
    const { privateKey, publicKey } = await generateKeyPair("Ed25519");
    const purpose = "telestra-capture-permit-v2+jwt";
    const header = { alg: "Ed25519", typ: purpose, kid: "key-permit-proposal" };
    const sign = async (
      override: Record<string, unknown> = {},
      claims: Record<string, unknown> = {},
    ) => {
      try {
        return await new SignJWT({ ...example.claims, ...claims })
          .setProtectedHeader({ ...header, ...override })
          .sign(privateKey);
      } catch {
        throw new Error("提案用のメモリ内署名を作れません。");
      }
    };
    // 失敗の例外にpayloadやJWSを残さず、構成済み公開鍵だけで調べる。
    const check = async (raw: string) => {
      try {
        if (Buffer.byteLength(raw, "utf8") > 8192) return "jws-rejected";
        const h = decodeProtectedHeader(raw);
        if (
          h.alg !== header.alg ||
          h.typ !== purpose ||
          h.kid !== header.kid ||
          Object.keys(h).some((key) => !["alg", "kid", "typ"].includes(key))
        )
          return "jws-rejected";
        // 未来の確定予約も検証して待機できるよう、署名確認とnbfによる実行時刻判定を分ける。
        const { payload } = await compactVerify(raw, publicKey, {
          algorithms: ["Ed25519"],
        });
        const candidate = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(payload),
        ) as unknown;
        return candidateOutcome(candidate, samplePolicy());
      } catch {
        return "jws-rejected";
      }
    };
    const token = await sign();
    assert.equal(await check(token), "model-online");
    assert.equal(
      await check(await sign({}, { nbf: example.claims.nbf + 60 })),
      "model-waiting",
    );
    assert.equal(
      await check(await sign({}, { aud: "tv-api" })),
      "model-rejected",
    );
    assert.equal(await check(" ".repeat(8193)), "jws-rejected");
    for (const changed of [
      { typ: "tv-node+jwt" },
      { alg: "EdDSA" },
      { jku: "https://foreign.example.invalid/keys" },
      { x5u: "https://foreign.example.invalid/cert" },
    ])
      assert.equal(await check(await sign(changed)), "jws-rejected");
    const parts = token.split(".");
    parts[1] = "A" + parts[1]!.slice(1);
    assert.equal(await check(parts.join(".")), "jws-rejected");
  },
);
