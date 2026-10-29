// 認可世代を資格更新から分離し、D1の実状態と再起動で確認する。合成資格は表示・保存しない。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SignJWT } from "jose";
import { device, fixture, tenantId } from "./helper.ts";
import type { Fixture } from "./helper.ts";
import { enroll } from "./socket.ts";
import { scenario } from "../evidence.ts";

// 呼出元が与えた家庭と環境も条件に含め、別Nodeの値を比較対象へ混ぜない。
async function row(context: Fixture, nodeId: string) {
  const result = await context.database
    .prepare(
      "SELECT status,credential_version,authorization_epoch,session_epoch FROM nodes WHERE environment=? AND tenant_id=? AND node_id=?",
    )
    .bind("development", tenantId, nodeId)
    .first<{
      status: string;
      credential_version: number;
      authorization_epoch: number;
      session_epoch: number;
    }>();
  if (!result) throw new Error("合成Nodeの状態がありません。");
  return result;
}

scenario(
  "PERMIT-04",
  "authorization-epoch-rotate-rejoin-revoke-restart",
  "local-d1-separated-generations",
  "通常更新は認可世代を維持し、再参加・失効で進め、再起動後も保存する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-authz-epoch-01");
      const initial = await row(context, enrolled.target.nodeId);
      assert.equal(
        initial.authorization_epoch,
        2,
        "初回の明示的joinで認可世代を確定する",
      );
      const old = context.decode(enrolled.credential.accessToken);
      const rotated = await context.agent(
        "/nodes/rotate",
        enrolled.credential.accessToken,
        {
          proof: await context.deviceProof(
            enrolled.target,
            "rotate",
            old.jti as string,
          ),
        },
      );
      assert.equal(rotated.status, 200);
      const credential = (await rotated.json()) as {
        accessToken: string;
        credentialVersion: number;
      };
      const afterRotate = await row(context, enrolled.target.nodeId);
      assert.equal(
        afterRotate.authorization_epoch,
        initial.authorization_epoch,
      );
      assert.equal(
        afterRotate.credential_version,
        initial.credential_version + 1,
      );
      assert.equal(
        (
          await context.agent(
            "/agent/identity",
            enrolled.credential.accessToken,
          )
        ).status,
        401,
      );
      await context.restart();
      assert.deepEqual(await row(context, enrolled.target.nodeId), afterRotate);
      assert.equal(
        (await context.agent("/agent/identity", credential.accessToken)).status,
        200,
      );
      const code = await context.challenge(enrolled.target, enrolled.operator);
      const proof = await context.deviceProof(enrolled.target, "join", code);
      const joined = await context.agent("/nodes/join", "", {
        nodeId: enrolled.target.nodeId,
        code,
        proof,
      });
      assert.equal(joined.status, 200);
      const afterRejoin = await row(context, enrolled.target.nodeId);
      assert.equal(
        afterRejoin.authorization_epoch,
        initial.authorization_epoch + 1,
      );
      assert.equal(
        afterRejoin.credential_version,
        afterRotate.credential_version + 1,
      );
      assert.equal(
        (
          await context.agent("/nodes/join", "", {
            nodeId: enrolled.target.nodeId,
            code,
            proof,
          })
        ).status,
        401,
      );
      assert.deepEqual(await row(context, enrolled.target.nodeId), afterRejoin);
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
      const afterRevoke = await row(context, enrolled.target.nodeId);
      assert.equal(
        afterRevoke.authorization_epoch,
        afterRejoin.authorization_epoch + 1,
      );
      assert.equal(afterRevoke.status, "revoked");
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
      assert.deepEqual(
        await row(context, enrolled.target.nodeId),
        afterRevoke,
        "失効の再送で世代を進めない",
      );
      await context.restart();
      assert.deepEqual(await row(context, enrolled.target.nodeId), afterRevoke);
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "PERMIT-05",
  "authorization-epoch-legacy-migration",
  "persistent-v1-d1-upgrade",
  "既存の資格・予約・録画を保持して移行し、未移行DBを認可世代1へ補完しない",
  async () => {
    const context = await fixture(undefined, undefined, 1);
    try {
      const target = await device("tuner-authz-legacy-01");
      await context.database
        .prepare(
          "INSERT INTO nodes(environment,tenant_id,node_id,node_role,public_jwk,status,credential_version,session_epoch,capabilities,last_seen) VALUES(?,?,?,'tuner',?,'active',7,9,'{}',1234)",
        )
        .bind(
          "development",
          tenantId,
          target.nodeId,
          JSON.stringify(target.publicJwk),
        )
        .run();
      await context.database
        .prepare(
          "INSERT INTO reservations(environment,tenant_id,reservation_id,owner_id,state,revision,payload) VALUES(?,?,'reservation-migration-01','recorder-local','scheduled',4,'{}')",
        )
        .bind("development", tenantId)
        .run();
      const token = await legacyCredential(context, target.nodeId, 7);
      assert.equal(
        (await context.agent("/agent/identity", token)).status,
        503,
        "未移行台帳から資格認証を継続しない",
      );
      const migration = await readFile(
        "apps/control/migrations/0002-authorization-epoch.sql",
        "utf8",
      );
      await context.database.prepare(migration).run();
      const migrated = await row(context, target.nodeId);
      assert.deepEqual(migrated, {
        status: "active",
        credential_version: 7,
        session_epoch: 9,
        authorization_epoch: 1,
      });
      assert.equal(
        (await context.agent("/agent/identity", token)).status,
        200,
        "既存のv1資格は移行後も有効",
      );
      const reservation = await context.database
        .prepare(
          "SELECT revision,payload FROM reservations WHERE reservation_id='reservation-migration-01'",
        )
        .first<{ revision: number; payload: string }>();
      assert.deepEqual(reservation, { revision: 4, payload: "{}" });
      const recording = await context.database
        .prepare("SELECT COUNT(*) AS count FROM recordings")
        .first<{ count: number }>();
      assert.equal(recording?.count, 1);
      for (const invalid of [
        0,
        -1,
        1.5,
        9007199254740992,
        null,
        "invalid-generation",
      ]) {
        let denied = false;
        try {
          await context.database
            .prepare("UPDATE nodes SET authorization_epoch=? WHERE node_id=?")
            .bind(invalid, target.nodeId)
            .run();
        } catch {
          denied = true;
        }
        assert.equal(denied, true, "DB制約が不正な認可世代を拒否する");
        assert.deepEqual(await row(context, target.nodeId), migrated);
      }
      await context.restart();
      assert.deepEqual(await row(context, target.nodeId), migrated);
      assert.equal((await context.agent("/agent/identity", token)).status, 200);
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

// 旧wire形式の合成Node資格を作り、DBの境界値を通る資格だけをメモリ内で渡す。
async function legacyCredential(
  context: Fixture,
  nodeId: string,
  version: number,
): Promise<string> {
  return new SignJWT({
    iss: context.bindings.TELESTRA_CONTROL_ISSUER,
    aud: "tv-node-agent",
    sub: nodeId,
    iat: context.now(),
    exp: context.now() + 300,
    jti: crypto.randomUUID(),
    tenantId,
    environment: "development",
    nodeId,
    nodeRole: "tuner",
    credentialVersion: version,
  })
    .setProtectedHeader({
      alg: "EdDSA",
      typ: "tv-node+jwt",
      kid: context.signer.publicJwk.kid,
    })
    .sign(context.signer.privateKey);
}

scenario(
  "PERMIT-06",
  "authorization-epoch-limits-and-terminal-revoke",
  "safe-integer-generation-boundaries",
  "上限でjoin/rotateを拒否しても失効は確定し、世代を0へ戻さない",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-authz-max-01");
      await context.database
        .prepare("UPDATE nodes SET authorization_epoch=? WHERE node_id=?")
        .bind(Number.MAX_SAFE_INTEGER, enrolled.target.nodeId)
        .run();
      const old = context.decode(enrolled.credential.accessToken);
      const rotated = await context.agent(
        "/nodes/rotate",
        enrolled.credential.accessToken,
        {
          proof: await context.deviceProof(
            enrolled.target,
            "rotate",
            old.jti as string,
          ),
        },
      );
      assert.equal(
        rotated.status,
        200,
        "認可世代の上限だけで通常rotateを止めない",
      );
      assert.equal(
        (await row(context, enrolled.target.nodeId)).authorization_epoch,
        Number.MAX_SAFE_INTEGER,
      );
      const code = await context.challenge(enrolled.target, enrolled.operator);
      assert.equal(
        (
          await context.agent("/nodes/join", "", {
            nodeId: enrolled.target.nodeId,
            code,
            proof: await context.deviceProof(enrolled.target, "join", code),
          })
        ).status,
        409,
      );
      const joinCount = await context.database
        .prepare("SELECT COUNT(*) AS count FROM node_joins WHERE node_id=?")
        .bind(enrolled.target.nodeId)
        .first<{ count: number }>();
      assert.equal(
        joinCount?.count,
        1,
        "上限による拒否では参加権利を消費しない",
      );
      await context.database
        .prepare("UPDATE nodes SET credential_version=? WHERE node_id=?")
        .bind(Number.MAX_SAFE_INTEGER, enrolled.target.nodeId)
        .run();
      const token = await legacyCredential(
        context,
        enrolled.target.nodeId,
        Number.MAX_SAFE_INTEGER,
      );
      const claims = context.decode(token);
      assert.equal(
        (
          await context.agent("/nodes/rotate", token, {
            proof: await context.deviceProof(
              enrolled.target,
              "rotate",
              claims.jti as string,
            ),
          })
        ).status,
        409,
      );
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
      const stopped = await row(context, enrolled.target.nodeId);
      assert.equal(stopped.status, "revoked");
      assert.equal(stopped.authorization_epoch, Number.MAX_SAFE_INTEGER);
      assert.equal(stopped.credential_version, Number.MAX_SAFE_INTEGER);
      assert.equal((await context.agent("/agent/identity", token)).status, 401);
      assert.equal(
        (await context.register(enrolled.target, enrolled.operator)).status,
        200,
        "同じ登録の再送で失効を解除しない",
      );
      assert.equal(
        (
          await context.browser("/nodes/challenges", enrolled.operator, {
            method: "POST",
            body: { nodeId: enrolled.target.nodeId },
          })
        ).status,
        409,
      );
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
      await context.restart();
      assert.deepEqual(await row(context, enrolled.target.nodeId), stopped);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "PERMIT-07",
  "authorization-epoch-atomic-write-failure",
  "sqlite-trigger-fault-injection",
  "認可世代の保存失敗でjoin/失効を成功扱いせず、参加権利と全世代を保持する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-authz-io-01");
      const before = await row(context, enrolled.target.nodeId);
      const code = await context.challenge(enrolled.target, enrolled.operator);
      const input = {
        nodeId: enrolled.target.nodeId,
        code,
        proof: await context.deviceProof(enrolled.target, "join", code),
      };
      // 固定した試験TriggerでD1の実書込を拒否し、batch全体のrollbackを確認する。
      await context.database
        .prepare(
          "CREATE TRIGGER fail_authorization_epoch BEFORE UPDATE OF authorization_epoch ON nodes BEGIN SELECT RAISE(ABORT,'synthetic authorization write failure'); END",
        )
        .run();
      assert.equal((await context.agent("/nodes/join", "", input)).status, 503);
      assert.deepEqual(await row(context, enrolled.target.nodeId), before);
      assert.equal(
        (
          await context.browser(
            `/nodes/${enrolled.target.nodeId}/revoke`,
            enrolled.operator,
            { method: "POST", body: {} },
          )
        ).status,
        503,
      );
      assert.deepEqual(await row(context, enrolled.target.nodeId), before);
      const remaining = await context.database
        .prepare("SELECT COUNT(*) AS count FROM node_joins WHERE node_id=?")
        .bind(enrolled.target.nodeId)
        .first<{ count: number }>();
      assert.equal(remaining?.count, 1, "join失敗後も同じ参加権利が残る");
      const old = context.decode(enrolled.credential.accessToken);
      assert.equal(
        (
          await context.agent(
            "/nodes/rotate",
            enrolled.credential.accessToken,
            {
              proof: await context.deviceProof(
                enrolled.target,
                "rotate",
                old.jti as string,
              ),
            },
          )
        ).status,
        200,
        "通常更新は認可世代へ書き込まない",
      );
      await context.database
        .prepare("DROP TRIGGER fail_authorization_epoch")
        .run();
      assert.equal((await context.agent("/nodes/join", "", input)).status, 200);
      const recovered = await row(context, enrolled.target.nodeId);
      assert.equal(
        recovered.authorization_epoch,
        before.authorization_epoch + 1,
      );
      assert.equal(recovered.credential_version, before.credential_version + 2);
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "PERMIT-08",
  "authorization-epoch-race-and-tenant-denials",
  "concurrent-rotate-and-revoke",
  "通常更新と失効が競合しても失効状態へ収束し、別家庭・環境と無権限要求を隔離する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-authz-race-01");
      const before = await row(context, enrolled.target.nodeId);
      await context.database
        .prepare(
          "INSERT INTO nodes(environment,tenant_id,node_id,node_role,public_jwk,status,credential_version,authorization_epoch) VALUES('staging','foreign-household',?,'tuner',?,'active',5,17)",
        )
        .bind(enrolled.target.nodeId, JSON.stringify(enrolled.target.publicJwk))
        .run();
      assert.equal(
        (
          await context.browser(
            `/nodes/${enrolled.target.nodeId}/revoke`,
            await context.mint("viewer-local"),
            { method: "POST", body: {} },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await context.browser(
            `/nodes/${enrolled.target.nodeId}/revoke`,
            enrolled.operator,
            { method: "POST", body: { authorizationEpoch: 99 } },
          )
        ).status,
        400,
      );
      assert.deepEqual(await row(context, enrolled.target.nodeId), before);
      for (const [environment, tenant, epoch] of [
        ["development", "foreign-household", 19],
        ["staging", tenantId, 23],
      ] as const) {
        await context.database
          .prepare(
            "INSERT INTO nodes(environment,tenant_id,node_id,node_role,public_jwk,status,credential_version,authorization_epoch) VALUES(?,?,?,'tuner',?,'active',5,?)",
          )
          .bind(
            environment,
            tenant,
            enrolled.target.nodeId,
            JSON.stringify(enrolled.target.publicJwk),
            epoch,
          )
          .run();
      }
      const claims = context.decode(enrolled.credential.accessToken);
      const proofs = await Promise.all(
        [0, 1, 2].map(() =>
          context.deviceProof(enrolled.target, "rotate", claims.jti as string),
        ),
      );
      const results = await Promise.all([
        ...proofs.map((proof) =>
          context.agent("/nodes/rotate", enrolled.credential.accessToken, {
            proof,
          }),
        ),
        context.browser(
          `/nodes/${enrolled.target.nodeId}/revoke`,
          enrolled.operator,
          { method: "POST", body: {} },
        ),
      ]);
      assert.equal(results.at(-1)?.status, 200);
      for (const result of results.slice(0, -1)) {
        assert.equal(
          [200, 401].includes(result.status),
          true,
          "競合したrotateは成功または旧資格として拒否する",
        );
        if (result.status === 200) {
          const credential = (await result.json()) as { accessToken: string };
          assert.equal(
            (await context.agent("/agent/identity", credential.accessToken))
              .status,
            401,
          );
        }
      }
      const after = await row(context, enrolled.target.nodeId);
      assert.equal(after.status, "revoked");
      assert.equal(after.authorization_epoch, before.authorization_epoch + 1);
      assert.equal(
        [before.credential_version + 1, before.credential_version + 2].includes(
          after.credential_version,
        ),
        true,
      );
      const foreign = await context.database
        .prepare(
          "SELECT status,credential_version,authorization_epoch FROM nodes WHERE environment='staging' AND tenant_id='foreign-household' AND node_id=?",
        )
        .bind(enrolled.target.nodeId)
        .first();
      assert.deepEqual(foreign, {
        status: "active",
        credential_version: 5,
        authorization_epoch: 17,
      });
      for (const [environment, tenant, epoch] of [
        ["development", "foreign-household", 19],
        ["staging", tenantId, 23],
      ] as const) {
        const isolated = await context.database
          .prepare(
            "SELECT status,authorization_epoch FROM nodes WHERE environment=? AND tenant_id=? AND node_id=?",
          )
          .bind(environment, tenant, enrolled.target.nodeId)
          .first();
        assert.deepEqual(isolated, {
          status: "active",
          authorization_epoch: epoch,
        });
      }
      await context.restart();
      assert.deepEqual(await row(context, enrolled.target.nodeId), after);
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "PERMIT-09",
  "authorization-epoch-one-time-join-and-identity-conflict",
  "single-use-join-cas",
  "同じ参加権利の同時使用で認可を一度だけ更新し、鍵やRoleの変更で世代を初期化しない",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-authz-join-race-01");
      const before = await row(context, enrolled.target.nodeId);
      const code = await context.challenge(enrolled.target, enrolled.operator);
      const input = {
        nodeId: enrolled.target.nodeId,
        code,
        proof: await context.deviceProof(enrolled.target, "join", code),
      };
      assert.equal(
        (
          await context.agent("/nodes/join", "", {
            ...input,
            authorizationEpoch: 1,
          })
        ).status,
        400,
      );
      assert.deepEqual(await row(context, enrolled.target.nodeId), before);
      const responses = await Promise.all([
        context.agent("/nodes/join", "", input),
        context.agent("/nodes/join", "", input),
      ]);
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 401],
      );
      const after = await row(context, enrolled.target.nodeId);
      assert.equal(after.authorization_epoch, before.authorization_epoch + 1);
      assert.equal(after.credential_version, before.credential_version + 1);
      assert.equal(after.session_epoch, before.session_epoch);
      assert.equal(
        (
          await context.agent(
            "/agent/identity",
            enrolled.credential.accessToken,
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await context.register(
            await device(enrolled.target.nodeId),
            enrolled.operator,
          )
        ).status,
        409,
      );
      assert.equal(
        (await context.register(enrolled.target, enrolled.operator, "encoder"))
          .status,
        409,
      );
      assert.deepEqual(await row(context, enrolled.target.nodeId), after);
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);
