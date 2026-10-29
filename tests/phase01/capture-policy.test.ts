// D1の確定版・割当と端末証明を使い、policyを実workerdから取得する。秘密値は記録しない。
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportJWK, generateKeyPair } from "jose";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { policyCases } from "../fixtures/policy-cases.ts";
import { policyClaims } from "../fixtures/policy.ts";
import { CapturePermitVerifier } from "../../packages/capture-permit/index.ts";
import { fixtureTLS } from "../../scripts/fixture-tls.ts";
import { fixture, tenantId } from "./helper.ts";
import type { Fixture } from "./helper.ts";
import { enroll } from "./socket.ts";
import type { Enrolled } from "./socket.ts";
import {
  saveCapturePolicy,
  issueCapturePolicy,
} from "../../apps/control/capture-policy.ts";
import { CapturePolicyVerifier } from "../../packages/capture-permit/policy.ts";
import type { ControlMap } from "../../packages/control-contracts/index.ts";
import { scenario } from "../evidence.ts";

// 実行Schedulerの代用ではなく、テストだけで確定予約revision 1を明示する。
async function assignment(
  context: Fixture,
  enrolled: Enrolled,
  id = "recording-policy-01",
): Promise<ControlMap["CapturePolicyV2"]> {
  const now = context.now(),
    reservationId = `reservation-${id}`,
    startsAt = new Date((now + 30) * 1000).toISOString(),
    endsAt = new Date((now + 3600) * 1000).toISOString();
  const body = {
    reservationId,
    serviceKey: "service-policy-01",
    startsAt,
    endsAt,
  };
  assert.equal(
    (
      await context.browser(
        "/reservations",
        await context.mint("recorder-local"),
        { method: "POST", body },
      )
    ).status,
    202,
  );
  await context.database
    .prepare(
      "UPDATE reservations SET revision=1 WHERE environment='development' AND tenant_id=? AND reservation_id=?",
    )
    .bind(tenantId, reservationId)
    .run();
  // 合成した既存録画台帳だけを置く。媒体・原本・完了状態を作ったとは扱わない。
  await context.database
    .prepare(
      "INSERT INTO recordings(environment,tenant_id,recording_id,owner_id,payload) VALUES('development',?,?,'recorder-local',?)",
    )
    .bind(
      tenantId,
      id,
      JSON.stringify({
        recordingId: id,
        state: "partial",
        attemptIds: [`attempt-${id}`],
      }),
    )
    .run();
  const row = await context.database
    .prepare("SELECT authorization_epoch FROM nodes WHERE node_id=?")
    .bind(enrolled.target.nodeId)
    .first<{ authorization_epoch: number }>();
  if (!row) throw new Error("合成Nodeの認可状態がありません。");
  return {
    schemaVersion: 2,
    iss: context.bindings.TELESTRA_CONTROL_ISSUER,
    aud: "telestra-tuner-capture-policy",
    sub: enrolled.target.nodeId,
    jti: `policy-${id}`,
    iat: now,
    exp: now + 3600,
    tenantId,
    environment: "development",
    nodeId: enrolled.target.nodeId,
    nodeRole: "tuner",
    authorizationEpoch: row.authorization_epoch,
    assignmentEpoch: 1,
    reservationId,
    reservationRevision: 1,
    recordingId: id,
    attemptId: `attempt-${id}`,
    backendId: "backend-policy-01",
    serviceKey: body.serviceKey,
    captureScope: "service-filtered",
    storageScopeId: "scope-policy-01",
    permitId: `permit-${id}`,
    maxPermitLifetime: 3600,
    maxOfflineSeconds: 1800,
    captureEarliest: now + 30,
    captureLatest: now + 3600,
    maxSpoolBytes: 8388608,
    revoked: false,
  };
}
function sourceEnv(context: Fixture) {
  return { ...context.bindings, TELESTRA_DB: context.database };
}
async function fetchPolicy(
  context: Fixture,
  enrolled: Enrolled,
  recordingId: string,
  overrides: {
    proof?: string;
    token?: string;
    origin?: string;
    http?: boolean;
    extra?: object;
  } = {},
) {
  const token = overrides.token ?? enrolled.credential.accessToken;
  const id = context.decode(token).jti;
  const proof =
    overrides.proof ??
    (await context.deviceProof(
      enrolled.target,
      "capture-policy",
      `capture-policy.v2\0${recordingId}\0${id}`,
    ));
  return context.mf.dispatchFetch(
    `${overrides.http ? "http" : "https"}://localhost/agent/capture-policy/v2`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(overrides.origin ? { Origin: overrides.origin } : {}),
      },
      body: JSON.stringify({ recordingId, proof, ...overrides.extra }),
    },
  );
}

scenario(
  "POLICY-02",
  "d1-policy-issue-proof-and-current-authority",
  "local-current-node-reservation-assignment",
  "現在のD1割当だけを署名し、通常rotate・再参加・失効を正しく区別する",
  async () => {
    const context = await fixture(undefined, undefined, 3, true);
    try {
      const enrolled = await enroll(context, "tuner-policy-01"),
        claims = await assignment(context, enrolled);
      assert.equal(
        await saveCapturePolicy(sourceEnv(context), claims, context.now()),
        true,
      );
      assert.equal(
        await saveCapturePolicy(sourceEnv(context), claims, context.now()),
        false,
        "同一snapshotの再送は書き換えない",
      );
      const response = await fetchPolicy(context, enrolled, claims.recordingId);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const body = (await response.json()) as { policy: string };
      const verifier = await CapturePolicyVerifier.create(
        claims.iss,
        [{ ...context.policySigner.publicJwk, alg: "Ed25519" }],
        3600,
      );
      const identity = {
        tenantId,
        environment: "development",
        nodeId: enrolled.target.nodeId,
        nodeRole: "tuner" as const,
      };
      const verified = await verifier.verify(
        body.policy,
        identity,
        context.now(),
        claims.iat,
      );
      assert.equal(verified.claims.assignmentEpoch, 1);
      assert.equal(verified.executionAuthorized, false);
      await context.restart();
      assert.equal(
        (await fetchPolicy(context, enrolled, claims.recordingId)).status,
        200,
      );
      const tokenId = context.decode(enrolled.credential.accessToken)
        .jti as string;
      const rotated = await context.agent(
        "/nodes/rotate",
        enrolled.credential.accessToken,
        {
          proof: await context.deviceProof(enrolled.target, "rotate", tokenId),
        },
      );
      assert.equal(rotated.status, 200);
      const credential = (await rotated.json()) as Enrolled["credential"];
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            token: credential.accessToken,
          })
        ).status,
        200,
        "通常rotateでpolicyを失効させない",
      );
      assert.equal(
        (await fetchPolicy(context, enrolled, claims.recordingId)).status,
        401,
      );
      const code = await context.challenge(enrolled.target, enrolled.operator);
      const rejoined = await context.agent("/nodes/join", "", {
        nodeId: enrolled.target.nodeId,
        code,
        proof: await context.deviceProof(enrolled.target, "join", code),
      });
      assert.equal(rejoined.status, 200);
      const joinedCredential =
        (await rejoined.json()) as Enrolled["credential"];
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            token: joinedCredential.accessToken,
          })
        ).status,
        404,
        "旧認可世代の割当を再発行しない",
      );
      const fresh = {
        ...claims,
        jti: "policy-reauthorized-01",
        permitId: "permit-reauthorized-01",
        assignmentEpoch: 2,
        authorizationEpoch: claims.authorizationEpoch + 1,
      };
      assert.equal(
        await saveCapturePolicy(sourceEnv(context), fresh, context.now()),
        true,
      );
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            token: joinedCredential.accessToken,
          })
        ).status,
        200,
      );
      await context.browser(
        `/nodes/${enrolled.target.nodeId}/revoke`,
        enrolled.operator,
        { method: "POST", body: {} },
      );
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            token: joinedCredential.accessToken,
          })
        ).status,
        401,
      );
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "POLICY-03",
  "policy-cas-proof-and-resource-denials",
  "primary-d1-negative-policy-matrix",
  "未確定予約・別Node・別用途証明・古い割当・競合保存を拒否する",
  async () => {
    const context = await fixture(undefined, undefined, 3, true);
    try {
      const enrolled = await enroll(context, "tuner-policy-denial-01"),
        other = await enroll(context, "tuner-policy-other-01"),
        encoder = await enroll(context, "encoder-policy-denial-01", "encoder");
      const claims = await assignment(
        context,
        enrolled,
        "recording-policy-denial-01",
      );
      await context.database
        .prepare("UPDATE reservations SET revision=0 WHERE reservation_id=?")
        .bind(claims.reservationId)
        .run();
      let denied = false;
      try {
        await saveCapturePolicy(sourceEnv(context), claims, context.now());
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "revision 0を確認済みへ補完しない");
      await context.database
        .prepare("UPDATE reservations SET revision=1 WHERE reservation_id=?")
        .bind(claims.reservationId)
        .run();
      assert.equal(
        await saveCapturePolicy(sourceEnv(context), claims, context.now()),
        true,
      );
      assert.equal(
        (await fetchPolicy(context, other, claims.recordingId)).status,
        404,
      );
      assert.equal(
        (await fetchPolicy(context, encoder, claims.recordingId)).status,
        403,
      );
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            http: true,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            origin: "https://tv.example.test",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            extra: { url: "https://example.invalid/" },
          })
        ).status,
        400,
      );
      const credentialId = context.decode(enrolled.credential.accessToken)
        .jti as string;
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            proof: await context.deviceProof(
              enrolled.target,
              "connect",
              credentialId,
            ),
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetchPolicy(context, enrolled, claims.recordingId, {
            proof: await context.deviceProof(
              enrolled.target,
              "capture-policy",
              `capture-policy.v2\0other-recording\0${credentialId}`,
            ),
          })
        ).status,
        401,
      );
      const first = {
        ...claims,
        jti: "policy-race-first-01",
        permitId: "permit-race-first-01",
        assignmentEpoch: 2,
      };
      const second = {
        ...first,
        jti: "policy-race-second-01",
        permitId: "permit-race-second-01",
      };
      const saved = await Promise.allSettled([
        saveCapturePolicy(sourceEnv(context), first, context.now()),
        saveCapturePolicy(sourceEnv(context), second, context.now()),
      ]);
      assert.equal(
        saved.filter((item) => item.status === "fulfilled").length,
        1,
        "同じ次世代のsnapshotを一つだけ確定する",
      );
      const reassigned = {
        ...claims,
        nodeId: other.target.nodeId,
        sub: other.target.nodeId,
        jti: "policy-reassign-01",
        permitId: "permit-reassign-01",
        assignmentEpoch: 3,
        attemptId: "attempt-reassigned-01",
      };
      assert.equal(
        await saveCapturePolicy(sourceEnv(context), reassigned, context.now()),
        true,
      );
      assert.equal(
        (await fetchPolicy(context, enrolled, claims.recordingId)).status,
        404,
        "旧Nodeに過去のsnapshotを返さない",
      );
      assert.equal(
        (await fetchPolicy(context, other, claims.recordingId)).status,
        200,
      );
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

// 子プロセスのIPCを非同期で扱い、loopback Workerのイベント処理を止めない。
async function policyProcess(
  binary: string,
  input: unknown,
): Promise<{
  ok: boolean;
  results?: string[];
  authorizationEpoch?: number;
  assignmentEpoch?: number;
  executionAuthorized?: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      [],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1048576,
        env: {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOPROXY: "off",
          GOSUMDB: "off",
        },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Goのpolicy試験プロセスが失敗しました。"));
          return;
        }
        try {
          resolve(
            JSON.parse(stdout) as Awaited<ReturnType<typeof policyProcess>>,
          );
        } catch {
          reject(new Error("Goのpolicy試験応答を確認してください。"));
        }
      },
    );
    child.stdin?.on("error", () =>
      reject(new Error("Goのpolicy試験入力を渡せません。")),
    );
    child.stdin?.end(JSON.stringify(input));
  });
}
scenario(
  "POLICY-04",
  "go-policy-fetch-over-real-loopback-tls",
  "go-device-proof-local-workerd-policy",
  "Goが実TLS・端末証明・現在資格でpolicyを取得し、署名・主体を検証する",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "telestra-policy-go-"));
    const tls = fixtureTLS();
    const context = await fixture(tls, undefined, 3, true);
    try {
      const binary = join(directory, "policyfixture");
      const built = spawnSync(
        "go",
        ["build", "-o", binary, "./nodes/tuner/cmd/policyfixture"],
        {
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            GOTOOLCHAIN: "local",
            GOPROXY: "off",
            GOSUMDB: "off",
          },
        },
      );
      assert.equal(built.status, 0, "Goのpolicy試験器をビルドできる");
      const enrolled = await enroll(context, "tuner-policy-go-01"),
        claims = await assignment(context, enrolled, "recording-policy-go-01");
      await saveCapturePolicy(sourceEnv(context), claims, context.now());
      const secret = await exportJWK(enrolled.target.privateKey);
      const input = {
        mode: "fetch",
        issuer: context.bindings.TELESTRA_CONTROL_ISSUER,
        policyKeys: [{ ...context.policySigner.publicJwk, alg: "Ed25519" }],
        controlKeys: [context.signer.publicJwk],
        identity: {
          NodeID: enrolled.target.nodeId,
          TenantID: tenantId,
          Environment: "development",
          Role: "tuner",
        },
        maxLifetime: 3600,
        endpoint: (await context.mf.ready).origin,
        rootPEM: tls.certificate,
        privateSeed: secret.d,
        deviceKeyID: enrolled.target.publicJwk.kid,
        credential: enrolled.credential.accessToken,
        recordingId: claims.recordingId,
      };
      const result = await policyProcess(binary, input);
      assert.equal(result.ok, true);
      assert.equal(result.authorizationEpoch, claims.authorizationEpoch);
      assert.equal(result.assignmentEpoch, 1);
      assert.equal(result.executionAuthorized, false);
      assert.equal(
        (
          await policyProcess(binary, {
            ...input,
            recordingId: "other-recording",
          })
        ).ok,
        false,
      );
      assert.equal(
        (
          await policyProcess(binary, {
            ...input,
            policyKeys: [{ ...context.signer.publicJwk, alg: "Ed25519" }],
          })
        ).ok,
        false,
        "別用途の鍵をpolicyへ流用しない",
      );
      assert.equal(
        (
          await policyProcess(binary, {
            ...input,
            endpoint: "https://example.invalid",
          })
        ).ok,
        false,
        "試験コマンドはloopback以外へ接続しない",
      );
      await context.browser(
        `/nodes/${enrolled.target.nodeId}/revoke`,
        enrolled.operator,
        { method: "POST", body: {} },
      );
      assert.equal((await policyProcess(binary, input)).ok, false);
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

scenario(
  "POLICY-05",
  "go-node-workerd-signed-policy-matrix",
  "cross-runtime-purpose-and-bounds-v2",
  "同じpolicyとPermitの正常・異常入力を3実装で照合し、署名と最新性の違いも検証する",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "telestra-policy-matrix-"));
    let worker: Miniflare | undefined;
    let egress = 0;
    try {
      const binary = join(directory, "policyfixture");
      const built = spawnSync(
        "go",
        ["build", "-o", binary, "./nodes/tuner/cmd/policyfixture"],
        {
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            GOTOOLCHAIN: "local",
            GOPROXY: "off",
            GOSUMDB: "off",
          },
        },
      );
      assert.equal(built.status, 0, "Goのpolicy検証器をビルドできる");
      const policyPair = await generateKeyPair("Ed25519"),
        permitPair = await generateKeyPair("Ed25519");
      const policyKey = {
          ...(await exportJWK(policyPair.publicKey)),
          alg: "Ed25519",
          kid: "policy-matrix-key",
        },
        permitKey = {
          ...(await exportJWK(permitPair.publicKey)),
          alg: "Ed25519",
          kid: "permit-matrix-key",
        };
      const identity = {
        tenantId: policyClaims.tenantId,
        environment: policyClaims.environment,
        nodeId: policyClaims.nodeId,
        nodeRole: "tuner" as const,
      };
      const policy = await CapturePolicyVerifier.create(
          policyClaims.iss,
          [policyKey],
          3600,
        ),
        permit = await CapturePermitVerifier.create(policyClaims.iss, [
          permitKey,
        ]);
      const cases = await policyCases(
        policyPair.privateKey,
        permitPair.privateKey,
        policyKey.kid,
        permitKey.kid,
      );
      assert.equal(cases.length, 94, "共有するpolicy入力は94件");
      const bundle = await build({
        entryPoints: ["tests/fixtures/policy-worker.ts"],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2023",
      });
      worker = new Miniflare({
        cf: false,
        modules: true,
        script: bundle.outputFiles[0]!.text,
        host: "127.0.0.1",
        port: 0,
        compatibilityDate: "2026-07-30",
        log: new Log(LogLevel.ERROR),
        outboundService: () => {
          egress++;
          return new Response("通信禁止", { status: 403 });
        },
      });
      for (let start = 0; start < cases.length; start += 32) {
        const group = cases.slice(start, start + 32),
          input = {
            issuer: policyClaims.iss,
            policyKeys: [policyKey],
            permitKeys: [permitKey],
            identity,
            maxLifetime: 3600,
            cases: group.map(({ policy, permit, now, maxObserved }) => ({
              policy,
              permit,
              now,
              maxObserved,
            })),
          };
        const expected = group.map((item) => item.expected),
          labels = group.map((item) => item.label).join(",");
        const go = await policyProcess(binary, {
          ...input,
          mode: "verify",
          identity: {
            NodeID: identity.nodeId,
            TenantID: identity.tenantId,
            Environment: identity.environment,
            Role: "tuner",
          },
        });
        assert.equal(go.ok, true);
        assert.deepEqual(go.results, expected, labels);
        const response: Awaited<ReturnType<Miniflare["dispatchFetch"]>> =
          await worker.dispatchFetch("http://localhost/verify", {
            method: "POST",
            body: JSON.stringify(input),
          });
        assert.equal(response.status, 200);
        const fromWorker = (await response.json()) as { results: string[] };
        assert.deepEqual(fromWorker.results, expected, labels);
        for (const item of group) {
          let state: string = "rejected";
          try {
            state = (
              await policy.verifyPermit(
                item.policy,
                item.permit,
                permit,
                identity,
                item.now,
                item.maxObserved,
              )
            ).window;
          } catch {
            /* 拒否理由に入力を表示しない。 */
          }
          assert.equal(state, item.expected, item.label);
        }
      }
      assert.equal(egress, 0);
    } finally {
      await worker?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// 実D1の最初の読取直後に状態を更新し、署名後の再照合を決定的に試験する。
function changeAfterRead(context: Fixture, mutate: () => Promise<void>) {
  let first = true;
  type Statement = ReturnType<Fixture["database"]["prepare"]>;
  function wrap(statement: Statement): Statement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: Parameters<Statement["bind"]>) =>
            wrap(target.bind(...values));
        if (property === "first")
          return async <T>() => {
            const result = await target.first<T>();
            if (first) {
              first = false;
              await mutate();
            }
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return {
    ...context.bindings,
    TELESTRA_DB: {
      prepare: context.database.prepare.bind(context.database),
      withSession: (mode: "first-primary") => {
        const session = context.database.withSession(mode);
        return { prepare: (sql: string) => wrap(session.prepare(sql)) };
      },
    },
  };
}
scenario(
  "POLICY-06",
  "policy-source-changes-and-write-failure",
  "real-d1-state-change-during-issue",
  "保存失敗と署名待ち中の失効・予約・割当変更でpolicyを返さない",
  async () => {
    const context = await fixture(undefined, undefined, 3, true);
    try {
      const enrolled = await enroll(context, "tuner-policy-fault-01"),
        claims = await assignment(
          context,
          enrolled,
          "recording-policy-fault-01",
        );
      for (const invalid of [
        { ...claims, serviceKey: "wrong-service" },
        { ...claims, captureEarliest: claims.captureEarliest - 1 },
        { ...claims, captureLatest: claims.captureLatest + 1 },
      ]) {
        let denied = false;
        try {
          await saveCapturePolicy(sourceEnv(context), invalid, context.now());
        } catch {
          denied = true;
        }
        assert.equal(denied, true, "予約の範囲外を保存しない");
      }
      const empty = await context.database
        .prepare("SELECT COUNT(*) AS count FROM capture_policies")
        .first<{ count: number }>();
      assert.equal(empty?.count, 0);
      await context.database
        .prepare(
          "CREATE TRIGGER fail_policy_save BEFORE INSERT ON capture_policies BEGIN SELECT RAISE(ABORT,'synthetic policy write failure'); END",
        )
        .run();
      let failed = false;
      try {
        await saveCapturePolicy(sourceEnv(context), claims, context.now());
      } catch {
        failed = true;
      }
      assert.equal(failed, true);
      await context.database.prepare("DROP TRIGGER fail_policy_save").run();
      assert.equal(
        await saveCapturePolicy(sourceEnv(context), claims, context.now()),
        true,
      );
      const changed = changeAfterRead(context, async () => {
        const next = {
          ...claims,
          assignmentEpoch: 2,
          jti: "policy-source-next-01",
          permitId: "permit-source-next-01",
        };
        await saveCapturePolicy(sourceEnv(context), next, context.now());
      });
      let denied = false;
      try {
        await issueCapturePolicy(
          changed,
          enrolled.target.nodeId,
          enrolled.credential.credentialVersion,
          claims.recordingId,
          context.now,
        );
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "署名待ち中に変わった割当を返さない");
    } finally {
      await context.close();
    }
    for (const kind of [
      "revocation",
      "reservation-payload",
      "recording-owner",
    ]) {
      const context = await fixture(undefined, undefined, 3, true);
      try {
        const enrolled = await enroll(context, `tuner-policy-${kind}`),
          claims = await assignment(
            context,
            enrolled,
            `recording-policy-${kind}`,
          );
        await saveCapturePolicy(sourceEnv(context), claims, context.now());
        const changed = changeAfterRead(context, async () => {
          if (kind === "revocation") {
            assert.equal(
              (
                await context.browser(
                  `/nodes/${enrolled.target.nodeId}/revoke`,
                  enrolled.operator,
                  { method: "POST", body: {} },
                )
              ).status,
              200,
            );
          } else if (kind === "recording-owner") {
            await context.database
              .prepare(
                "UPDATE recordings SET owner_id='other-local' WHERE recording_id=?",
              )
              .bind(claims.recordingId)
              .run();
            const changedOwner = await context.database
              .prepare("SELECT owner_id FROM recordings WHERE recording_id=?")
              .bind(claims.recordingId)
              .first<{ owner_id: string }>();
            assert.equal(changedOwner?.owner_id, "other-local");
          } else {
            await context.database
              .prepare(
                "UPDATE reservations SET payload=? WHERE reservation_id=?",
              )
              .bind(
                JSON.stringify({
                  reservationId: claims.reservationId,
                  serviceKey: "changed-service",
                  startsAt: new Date(
                    claims.captureEarliest * 1000,
                  ).toISOString(),
                  endsAt: new Date(claims.captureLatest * 1000).toISOString(),
                }),
                claims.reservationId,
              )
              .run();
          }
        });
        let denied = false;
        try {
          await issueCapturePolicy(
            changed,
            enrolled.target.nodeId,
            enrolled.credential.credentialVersion,
            claims.recordingId,
            context.now,
          );
        } catch {
          denied = true;
        }
        assert.equal(denied, true, "署名の前後で変化した現在値を拒否する");
        assert.equal(context.egress, 0);
      } finally {
        await context.close();
      }
    }
  },
);

scenario(
  "POLICY-07",
  "explicit-policy-revocation-and-disabled-config",
  "no-unsigned-policy-fallback",
  "署名付き割当失効を返し、署名未構成時や別利用者の録画にpolicyを発行しない",
  async () => {
    const disabled = await fixture();
    try {
      const enrolled = await enroll(disabled, "tuner-policy-disabled");
      assert.equal(
        (await fetchPolicy(disabled, enrolled, "recording-policy-disabled"))
          .status,
        503,
      );
    } finally {
      await disabled.close();
    }
    const context = await fixture(undefined, undefined, 3, true);
    try {
      const enrolled = await enroll(context, "tuner-policy-revoked"),
        claims = await assignment(
          context,
          enrolled,
          "recording-policy-revoked",
        );
      await context.database
        .prepare(
          "UPDATE recordings SET owner_id='other-local' WHERE recording_id=?",
        )
        .bind(claims.recordingId)
        .run();
      let denied = false;
      try {
        await saveCapturePolicy(sourceEnv(context), claims, context.now());
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "予約と録画の所有者を混ぜない");
      await context.database
        .prepare(
          "UPDATE recordings SET owner_id='recorder-local' WHERE recording_id=?",
        )
        .bind(claims.recordingId)
        .run();
      await saveCapturePolicy(sourceEnv(context), claims, context.now());
      const revoked = {
        ...claims,
        jti: "policy-explicit-revoke",
        permitId: "permit-explicit-revoke",
        assignmentEpoch: 2,
        revoked: true,
      };
      await saveCapturePolicy(sourceEnv(context), revoked, context.now());
      const response = await fetchPolicy(context, enrolled, claims.recordingId);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { policy: string };
      const verifier = await CapturePolicyVerifier.create(
        claims.iss,
        [{ ...context.policySigner.publicJwk, alg: "Ed25519" }],
        3600,
      );
      const verified = await verifier.verify(
        body.policy,
        {
          tenantId,
          environment: "development",
          nodeId: enrolled.target.nodeId,
          nodeRole: "tuner",
        },
        context.now(),
        claims.iat,
      );
      assert.equal(verified.claims.revoked, true);
      assert.equal(verified.executionAuthorized, false);
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);
