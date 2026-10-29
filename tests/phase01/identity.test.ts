// Nodeの署名・世代・失効と利用者の認可を、Cloudflareのローカル実装で検証する。
import assert from "node:assert/strict";
import { before, after } from "node:test";
import { SignJWT } from "jose";
import { device, fixture, origin, tenantId } from "./helper.ts";
import type { Fixture } from "./helper.ts";
import { scenario } from "../evidence.ts";

let context: Fixture;
before(async () => {
  context = await fixture();
});
after(async () => {
  if (context) await context.close();
});

scenario(
  "SEC-04",
  "browser-origin-and-token-boundary",
  "memory-oidc-key-v1",
  "悪性Origin・Cookieだけの要求・期限切れ・異なるaudience・失効したTokenを拒否する",
  async () => {
    const token = await context.mint("viewer-local");
    assert.equal((await context.browser("/session", token)).status, 200);
    for (const untrusted of ["https://tv.example.test.evil", "null", null])
      assert.equal(
        (await context.browser("/session", token, { origin: untrusted }))
          .status,
        403,
      );
    assert.equal(
      (
        await context.browser("/session", "", {
          headers: { Cookie: "session=synthetic-cookie" },
        })
      ).status,
      401,
    );
    for (const invalid of [
      await context.mint("viewer-local", { aud: "other-api" }),
      await context.mint("viewer-local", {
        exp: context.now() - 1,
        iat: context.now() - 60,
      }),
      await context.mint("viewer-local", { roles: ["admin"] }),
    ])
      assert.equal((await context.browser("/session", invalid)).status, 401);
    const foreign = await device("foreign-idp");
    assert.equal(
      (
        await context.browser(
          "/session",
          await context.mint("viewer-local", {}, foreign.privateKey),
        )
      ).status,
      401,
    );
    const preflight = await context.mf.dispatchFetch(
      "http://localhost/session",
      {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization",
        },
      },
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(
      (
        await context.browser("/sessions/revoke", token, {
          method: "POST",
          body: {},
        })
      ).status,
      200,
    );
    assert.equal((await context.browser("/session", token)).status, 401);
  },
);

scenario(
  "SEC-01",
  "recording-owner-and-tenant",
  "synthetic-recording-ledger-v1",
  "有効なTokenでも別所有者・別家庭の録画情報を読めない",
  async () => {
    assert.equal(
      (
        await context.browser(
          "/recordings/rec-owned-01",
          await context.mint("recorder-local"),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await context.browser(
          "/recordings/rec-owned-01",
          await context.mint("other-local"),
        )
      ).status,
      404,
    );
    await context.database
      .prepare(
        "INSERT INTO memberships(environment,tenant_id,subject,role,status) VALUES('development','foreign-household','foreign-user','viewer','active')",
      )
      .run();
    assert.equal(
      (
        await context.browser(
          "/recordings/rec-owned-01",
          await context.mint("foreign-user"),
        )
      ).status,
      401,
    );
  },
);

scenario(
  "CORE-02",
  "identity-input-validation",
  "control-schema-v1",
  "未知フィールド、秘密鍵の混入、過大な要求、機能種別の偽装を拒否する",
  async () => {
    const operator = await context.mint("operator-local");
    const target = await device("tuner-schema-01");
    const valid = {
      nodeId: target.nodeId,
      nodeRole: "tuner",
      publicKey: target.publicJwk,
    };
    for (const invalid of [
      { ...valid, shell: "id" },
      { ...valid, nodeRole: "admin" },
      { ...valid, publicKey: { ...target.publicJwk, d: "A".repeat(43) } },
    ])
      assert.equal(
        (
          await context.browser("/nodes", operator, {
            method: "POST",
            body: invalid,
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await context.browser("/nodes", operator, {
          method: "POST",
          body: { unexpected: "あ".repeat(8192) },
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await context.browser("/nodes", await context.mint("viewer-local"), {
          method: "POST",
          body: valid,
        })
      ).status,
      403,
    );
  },
);

scenario(
  "SEC-02",
  "device-key-and-identity-proof",
  "memory-device-key-v1",
  "登録された端末鍵とNode ID・家庭・環境に拘束されない参加要求を拒否する",
  async () => {
    const operator = await context.mint("operator-local");
    const target = await device("tuner-proof-01");
    assert.equal((await context.register(target, operator)).status, 201);
    const code = await context.challenge(target, operator);
    for (const overrides of [
      { nodeId: "tuner-other-01" },
      { tenantId: "foreign-household" },
      { environment: "staging" },
      { purpose: "rotate" },
    ]) {
      const proof = await context.deviceProof(target, "join", code, overrides);
      assert.equal(
        (
          await context.agent("/nodes/join", "", {
            nodeId: target.nodeId,
            code,
            proof,
          })
        ).status,
        401,
      );
    }
    const counterfeit = await device("tuner-proof-01");
    assert.equal(
      (
        await context.agent("/nodes/join", "", {
          nodeId: target.nodeId,
          code,
          proof: await context.deviceProof(counterfeit, "join", code),
        })
      ).status,
      401,
    );
  },
);

scenario(
  "NODE-01",
  "credential-issue-rotate-revoke",
  "memory-device-and-control-keys-v1",
  "一度限りの参加、署名検証、資格更新、旧世代と失効資格の拒否を確認する",
  async () => {
    const operator = await context.mint("operator-local");
    const target = await device("tuner-lifecycle-01");
    assert.equal((await context.register(target, operator)).status, 201);
    const code = await context.challenge(target, operator);
    const request = {
      nodeId: target.nodeId,
      code,
      proof: await context.deviceProof(target, "join", code),
    };
    const joined = await context.agent("/nodes/join", "", request);
    assert.equal(joined.status, 200);
    const first = (await joined.json()) as {
      accessToken: string;
      credentialVersion: number;
    };
    assert.equal(typeof first.accessToken, "string");
    assert.equal(
      (await context.agent("/agent/identity", first.accessToken)).status,
      200,
    );
    assert.equal((await context.agent("/nodes/join", "", request)).status, 401);
    assert.equal(
      (await context.browser("/session", first.accessToken)).status,
      401,
    );
    const parts = first.accessToken.split(".");
    parts[2] = (parts[2]?.[0] === "A" ? "B" : "A") + (parts[2]?.slice(1) ?? "");
    assert.equal(
      (await context.agent("/agent/identity", parts.join("."))).status,
      401,
    );
    const claims = context.decode(first.accessToken);
    const expired = await new SignJWT({
      ...claims,
      iat: context.now() - 60,
      exp: context.now() - 1,
    })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: context.signer.publicJwk.kid,
        typ: "tv-node+jwt",
      })
      .sign(context.signer.privateKey);
    assert.equal((await context.agent("/agent/identity", expired)).status, 401);
    const updated = await context.agent("/nodes/rotate", first.accessToken, {
      proof: await context.deviceProof(target, "rotate", String(claims.jti)),
    });
    assert.equal(updated.status, 200);
    const second = (await updated.json()) as {
      accessToken: string;
      credentialVersion: number;
    };
    assert.equal(second.credentialVersion, first.credentialVersion + 1);
    assert.equal(
      (await context.agent("/agent/identity", first.accessToken)).status,
      401,
    );
    assert.equal(
      (await context.agent("/agent/identity", second.accessToken)).status,
      200,
    );
    assert.equal(
      (
        await context.browser(`/nodes/${target.nodeId}/revoke`, operator, {
          method: "POST",
          body: {},
        })
      ).status,
      200,
    );
    assert.equal(
      (await context.agent("/agent/identity", second.accessToken)).status,
      401,
    );
  },
);

scenario(
  "PH01-01",
  "d1-restart-preserves-intent-and-recording",
  "synthetic-recording-ledger-v1",
  "workerdの停止・再起動後も予約intentと録画試行情報を保持する",
  async () => {
    const token = await context.mint("recorder-local");
    const request = {
      reservationId: "reservation-local-01",
      serviceKey: "service-demo-01",
      startsAt: new Date((context.now() + 600) * 1000).toISOString(),
      endsAt: new Date((context.now() + 1200) * 1000).toISOString(),
    };
    assert.equal(
      (
        await context.browser("/reservations", token, {
          method: "POST",
          body: request,
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await context.browser("/reservations", token, {
          method: "POST",
          body: request,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await context.browser(
          `/reservations/${request.reservationId}`,
          await context.mint("other-local"),
        )
      ).status,
      404,
    );
    await context.restart();
    const restored = await context.browser(
      `/reservations/${request.reservationId}`,
      token,
    );
    assert.equal(restored.status, 200);
    const state = (await restored.json()) as {
      state: string;
      serviceKey: string;
    };
    assert.equal(state.state, "scheduled");
    assert.equal(state.serviceKey, request.serviceKey);
    const recording = await context.browser("/recordings/rec-owned-01", token);
    assert.equal(recording.status, 200);
    const ledger = (await recording.json()) as { attemptIds: string[] };
    assert.deepEqual(ledger.attemptIds, ["attempt-local-01"]);
    const revoked = await context.database
      .prepare(
        "SELECT status FROM nodes WHERE environment=? AND tenant_id=? AND node_id=?",
      )
      .bind("development", tenantId, "tuner-lifecycle-01")
      .first<{ status: string }>();
    assert.equal(revoked?.status, "revoked");
    assert.equal(context.egress, 0);
  },
);
