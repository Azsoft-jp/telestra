// GoとWorkerのWSS・資格更新を検証する。秘密値は共通fixtureのIPCだけで扱う。
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, device } from "./helper.ts";
import { enroll } from "./socket.ts";
import { scenario } from "../evidence.ts";
import { agent, tlsMaterial } from "./go-agent.ts";

scenario(
  "NODE-02",
  "go-credential-checkpoint-reopen-and-resume",
  "loopback-tls-workerd-go-checkpoint-v2",
  "Goが履歴を開き直し、メモリ内の資格を確認情報へ照合して接続世代を引き継ぐ",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    let node: Awaited<ReturnType<typeof agent>> | undefined;
    try {
      const target = await device("tuner-go-checkpoint-01");
      const operator = await context.mint("operator-local");
      assert.equal((await context.register(target, operator)).status, 201);
      const joinCode = await context.challenge(target, operator);
      node = await agent(
        context,
        { target, joinCode, checkpoint: true },
        tls.certificate,
      );
      const rotated = await node.wait((r) => r.state === "rotated");
      const restored = await node.wait((r) => r.state === "restored");
      assert.equal(restored.generation, rotated.generation);
      await node.wait((r) => r.state === "connected");
      const row = await context.database
        .prepare(
          "SELECT credential_version,session_epoch,capabilities FROM nodes WHERE node_id=?",
        )
        .bind(target.nodeId)
        .first<{
          credential_version: number;
          session_epoch: number;
          capabilities: string;
        }>();
      assert.equal(row?.credential_version, restored.generation);
      assert.equal(row?.session_epoch, 2);
      assert.equal(
        (
          JSON.parse(row?.capabilities ?? "{}") as {
            resume?: { lastSessionEpoch: number };
          }
        ).resume?.lastSessionEpoch,
        1,
      );
      const events = await context.database
        .prepare(
          "SELECT count(*) AS count FROM identity_audit WHERE node_id=? AND action IN ('node.join','node.rotate')",
        )
        .bind(target.nodeId)
        .first<{ count: number }>();
      assert.equal(events?.count, 2);
      assert.equal(
        (
          await context.browser(`/nodes/${target.nodeId}/revoke`, operator, {
            method: "POST",
            body: {},
          })
        ).status,
        200,
      );
      const done = await node.wait((r) => r.done === true);
      assert.equal(done.code, "credentials");
      assert.equal(done.epoch, 2);
      assert.equal(context.egress, 0);
    } finally {
      try {
        await node?.close();
      } finally {
        await context.close();
      }
    }
  },
);

scenario(
  "NODE-02",
  "go-credential-lifecycle-renews-and-resumes",
  "loopback-tls-workerd-go-lifecycle-v1",
  "Goが旧接続を閉じて資格を更新し、新世代で再接続して台帳を保持し、失効時は停止する",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    let node: Awaited<ReturnType<typeof agent>> | undefined;
    try {
      const target = await device("tuner-go-lifecycle-01");
      const operator = await context.mint("operator-local");
      const recorder = await context.mint("recorder-local");
      const reservation = {
        reservationId: "reservation-go-renew-01",
        serviceKey: "service-demo-01",
        startsAt: new Date((context.now() + 600) * 1000).toISOString(),
        endsAt: new Date((context.now() + 1200) * 1000).toISOString(),
      };
      assert.equal(
        (
          await context.browser("/reservations", recorder, {
            method: "POST",
            body: reservation,
          })
        ).status,
        202,
      );
      assert.equal((await context.register(target, operator)).status, 201);
      const joinCode = await context.challenge(target, operator);
      node = await agent(
        context,
        { target, joinCode, lifecycle: true },
        tls.certificate,
      );
      const joined = await node.wait((r) => r.state === "joined");
      await node.wait(
        (r) => r.state === "connected" && r.generation === joined.generation,
      );
      const renewed = await node.wait(
        (r) =>
          r.state === "connected" &&
          r.generation === (joined.generation ?? 0) + 1,
        15_000,
      );
      assert.equal(renewed.rotations, 1);
      assert.equal(renewed.attempt, 2);
      const row = await context.database
        .prepare(
          "SELECT credential_version,session_epoch FROM nodes WHERE node_id=?",
        )
        .bind(target.nodeId)
        .first<{ credential_version: number; session_epoch: number }>();
      assert.deepEqual(row, {
        credential_version: renewed.generation,
        session_epoch: 2,
      });
      const response = await context.browser(
        `/reservations/${reservation.reservationId}`,
        recorder,
      );
      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as { state: string }).state,
        "scheduled",
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
      const done = await node.wait((r) => r.done === true);
      assert.equal(done.code, "credentials");
      assert.equal(done.rotations, 1);
      assert.equal(done.epoch, 2);
      const count = await context.database
        .prepare(
          "SELECT count(*) AS count FROM identity_audit WHERE node_id=? AND action='node.rotate'",
        )
        .bind(target.nodeId)
        .first<{ count: number }>();
      assert.equal(count?.count, 1);
      assert.equal(context.egress, 0);
    } finally {
      try {
        await node?.close();
      } finally {
        await context.close();
      }
    }
  },
);

scenario(
  "NODE-01",
  "go-join-rotate-wss",
  "loopback-tls-workerd-go-provision-v1",
  "Goが一回限りの参加権利と端末署名でjoin/rotateし、新世代資格でWSSへ接続する",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    let node: Awaited<ReturnType<typeof agent>> | undefined;
    try {
      const target = await device("tuner-go-provision-01");
      const operator = await context.mint("operator-local");
      assert.equal((await context.register(target, operator)).status, 201);
      const joinCode = await context.challenge(target, operator);
      node = await agent(context, { target, joinCode }, tls.certificate);
      const joined = await node.wait((record) => record.state === "joined");
      assert.ok((joined.generation ?? 0) > 0);
      const rotated = await node.wait((record) => record.state === "rotated");
      assert.equal(rotated.generation, (joined.generation ?? 0) + 1);
      await node.wait((record) => record.state === "connected");
      const row = await context.database
        .prepare(
          "SELECT credential_version,session_epoch,status FROM nodes WHERE node_id=?",
        )
        .bind(target.nodeId)
        .first<{
          credential_version: number;
          session_epoch: number;
          status: string;
        }>();
      assert.deepEqual(row, {
        credential_version: rotated.generation,
        session_epoch: 1,
        status: "active",
      });
      const events = await context.database
        .prepare(
          "SELECT action FROM identity_audit WHERE node_id=? AND action IN ('node.join','node.rotate') ORDER BY action",
        )
        .bind(target.nodeId)
        .all<{ action: string }>();
      assert.deepEqual(
        events.results.map((value) => value.action),
        ["node.join", "node.rotate"],
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
        (await node.wait((record) => record.done === true)).code,
        "credentials",
      );
      assert.equal(context.egress, 0);
    } finally {
      try {
        await node?.close();
      } finally {
        await context.close();
      }
    }
  },
);

scenario(
  "NODE-01",
  "go-wss-worker-command-and-revocation",
  "loopback-tls-workerd-go-v1",
  "GoがTLSと署名を検証してWorkerへ接続し、未実装ACKを返し、資格失効で再接続せず停止する",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    let node: Awaited<ReturnType<typeof agent>> | undefined;
    try {
      const enrolled = await enroll(context, "tuner-go-wss-01");
      node = await agent(context, enrolled, tls.certificate);
      assert.equal(
        (await node.wait((record) => record.state === "connected")).attempt,
        1,
      );
      const registered = await context.database
        .prepare("SELECT capabilities,last_seen FROM nodes WHERE node_id=?")
        .bind(enrolled.target.nodeId)
        .first<{ capabilities: string; last_seen: number }>();
      assert.ok(registered);
      assert.deepEqual(JSON.parse(registered.capabilities), {
        agentVersion: "phase01-local-fixture",
        nodeRole: "tuner",
        backend: "synthetic",
        capabilities: [],
        maxConcurrentJobs: 0,
      });
      const command = {
        commandId: "command-go-wss-01",
        type: "capture.cancel",
        payload: { recordingId: "rec-owned-01", attemptId: "attempt-local-01" },
        expiresAt: new Date((context.now() + 29) * 1000).toISOString(),
      };
      assert.equal(
        (
          await context.browser(
            `/nodes/${enrolled.target.nodeId}/commands`,
            enrolled.operator,
            { method: "POST", body: command },
          )
        ).status,
        202,
      );
      let acknowledged = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const response = await context.browser(
          `/nodes/${enrolled.target.nodeId}/commands`,
          enrolled.operator,
          { method: "POST", body: command },
        );
        const value = (await response.json()) as {
          state: string;
          result?: { accepted: boolean; code: string };
        };
        if (value.state === "acknowledged") {
          assert.deepEqual(value.result, {
            accepted: false,
            code: "not implemented",
          });
          acknowledged = true;
          break;
        }
        await delay(100);
      }
      assert.equal(
        acknowledged,
        true,
        "Goの未実装ACKをWorkerで確認できません。",
      );
      // 実際の15秒周期を待ち、Workerの永続last_seenがHeartbeatで更新されたことを確認する。
      let heartbeat = false;
      const heartbeatDeadline = Date.now() + 19_000;
      while (Date.now() < heartbeatDeadline) {
        const row = await context.database
          .prepare("SELECT last_seen FROM nodes WHERE node_id=?")
          .bind(enrolled.target.nodeId)
          .first<{ last_seen: number }>();
        if (row && row.last_seen >= registered.last_seen + 10) {
          heartbeat = true;
          break;
        }
        await delay(200);
      }
      assert.equal(heartbeat, true, "GoのHeartbeatをWorkerで確認できません。");
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
      const done = await node.wait((record) => record.done === true);
      assert.equal(done.code, "credentials");
      assert.equal(done.attempts, 1);
      assert.equal(done.epoch, 1);
      assert.equal(context.egress, 0);
    } finally {
      try {
        await node?.close();
      } finally {
        await context.close();
      }
    }
  },
);

scenario(
  "NODE-02",
  "go-wss-reconnect-preserves-ledger",
  "loopback-tls-workerd-restart-go-v1",
  "workerd停止後にGoがjitter付きで同じWSSへ再接続し、世代を進め、D1の予約と合成attemptを保持する",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    let node: Awaited<ReturnType<typeof agent>> | undefined;
    try {
      const enrolled = await enroll(context, "tuner-go-reconnect-01");
      const recorder = await context.mint("recorder-local");
      const reservation = {
        reservationId: "reservation-go-reconnect-01",
        serviceKey: "service-demo-01",
        startsAt: new Date((context.now() + 600) * 1000).toISOString(),
        endsAt: new Date((context.now() + 1200) * 1000).toISOString(),
      };
      assert.equal(
        (
          await context.browser("/reservations", recorder, {
            method: "POST",
            body: reservation,
          })
        ).status,
        202,
      );
      node = await agent(context, enrolled, tls.certificate);
      await node.wait((record) => record.state === "connected");
      const before = await context.database
        .prepare("SELECT session_epoch FROM nodes WHERE node_id=?")
        .bind(enrolled.target.nodeId)
        .first<{ session_epoch: number }>();
      assert.equal(before?.session_epoch, 1);
      await context.restart();
      await node.wait((record) => record.state === "reconnecting");
      const resumed = await node.wait(
        (record) => record.state === "connected" && (record.attempt ?? 0) > 1,
        15_000,
      );
      assert.ok((resumed.attempt ?? 0) > 1 && (resumed.attempt ?? 0) <= 8);
      const after = await context.database
        .prepare("SELECT session_epoch,capabilities FROM nodes WHERE node_id=?")
        .bind(enrolled.target.nodeId)
        .first<{ session_epoch: number; capabilities: string }>();
      assert.equal(after?.session_epoch, 2);
      const hello = JSON.parse(after?.capabilities ?? "{}") as {
        resume?: { lastSessionEpoch: number };
      };
      assert.equal(hello.resume?.lastSessionEpoch, 1);
      const restored = await context.browser(
        `/reservations/${reservation.reservationId}`,
        recorder,
      );
      assert.equal(restored.status, 200);
      const state = (await restored.json()) as {
        serviceKey: string;
        state: string;
      };
      assert.equal(state.state, "scheduled");
      assert.equal(state.serviceKey, reservation.serviceKey);
      const recording = await context.browser(
        "/recordings/rec-owned-01",
        recorder,
      );
      assert.equal(recording.status, 200);
      assert.deepEqual(
        ((await recording.json()) as { attemptIds: string[] }).attemptIds,
        ["attempt-local-01"],
      );
      assert.equal(context.egress, 0);
    } finally {
      try {
        await node?.close();
      } finally {
        await context.close();
      }
    }
  },
);
