// EncodeNode役のGoプロセスをローカル制御へ接続する。変換能力や媒体処理の実装とは扱わない。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, device } from "./helper.ts";
import type { Fixture } from "./helper.ts";
import { agent, tlsMaterial } from "./go-agent.ts";
import { scenario } from "../evidence.ts";

// 能力は現在のD1から読む。接続完了の通知だけでHeartbeatやRoleの検証を代用しない。
async function state(context: Fixture, nodeId: string) {
  const row = await context.database
    .prepare(
      "SELECT node_role,credential_version,session_epoch,capabilities,last_seen FROM nodes WHERE node_id=?",
    )
    .bind(nodeId)
    .first<{
      node_role: string;
      credential_version: number;
      session_epoch: number;
      capabilities: string;
      last_seen: number;
    }>();
  assert.ok(row);
  return row;
}
function capabilities(value: string) {
  const parsed = JSON.parse(value) as {
    nodeRole?: string;
    backend?: string;
    capabilities?: string[];
    maxConcurrentJobs?: number;
    resume?: { lastSessionEpoch: number };
  };
  assert.equal(parsed.nodeRole, "encoder");
  assert.equal(parsed.backend, "encoder");
  assert.deepEqual(parsed.capabilities, []);
  assert.equal(parsed.maxConcurrentJobs, 0);
  return parsed;
}
async function revoke(context: Fixture, nodeId: string, operator: string) {
  assert.equal(
    (
      await context.browser(`/nodes/${nodeId}/revoke`, operator, {
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
}

scenario(
  "NODE-01",
  "go-encoder-provision-heartbeat-and-revoke",
  "loopback-tls-go-encoder-role-v1",
  "EncodeNode役がjoin・rotate・WSS・既定Heartbeatを通り、録画制御を拒否して失効時に停止する",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    let node: Awaited<ReturnType<typeof agent>> | undefined;
    let expectedExit = 1;
    try {
      const target = await device("encoder-go-provision");
      const operator = await context.mint("operator-local");
      assert.equal(
        (await context.register(target, operator, "encoder")).status,
        201,
      );
      const joinCode = await context.challenge(target, operator);
      const config = { target, joinCode, nodeRole: "encoder" as const };
      node = await agent(context, config, tls.certificate);
      const joined = await node.wait((r) => r.state === "joined");
      const rotated = await node.wait((r) => r.state === "rotated");
      assert.equal(rotated.generation, (joined.generation ?? 0) + 1);
      await node.wait((r) => r.state === "connected");
      expectedExit = 0;
      const first = await state(context, target.nodeId);
      assert.equal(first.node_role, "encoder");
      assert.equal(first.credential_version, rotated.generation);
      capabilities(first.capabilities);
      // 15秒の既定Heartbeatを待ち、能力登録時と異なるlast_seenを実際に観測する。
      const deadline = Date.now() + 18_000;
      let heartbeat = first.last_seen;
      while (Date.now() < deadline && heartbeat <= first.last_seen) {
        await delay(100);
        heartbeat = (await state(context, target.nodeId)).last_seen;
      }
      assert.ok(
        heartbeat > first.last_seen,
        "EncodeNode役のHeartbeatを確認できません。",
      );
      const command = await context.browser(
        `/nodes/${target.nodeId}/commands`,
        operator,
        {
          method: "POST",
          body: {
            commandId: "command-encoder-denied",
            type: "capture.cancel",
            payload: {
              recordingId: "rec-owned-01",
              attemptId: "attempt-local-01",
            },
            expiresAt: new Date((context.now() + 20) * 1000).toISOString(),
          },
        },
      );
      assert.equal(command.status, 403);
      const status = await context.browser(
        `/nodes/${target.nodeId}/connection`,
        operator,
      );
      const connection = (await status.json()) as {
        state: string;
        pendingCommands: number;
      };
      assert.equal(connection.state, "connected");
      assert.equal(connection.pendingCommands, 0);
      await revoke(context, target.nodeId, operator);
      assert.equal(
        (await node.wait((r) => r.done === true)).code,
        "credentials",
      );
      assert.equal(context.egress, 0);
    } finally {
      try {
        await node?.close(expectedExit);
      } finally {
        await context.close();
      }
    }
  },
);

scenario(
  "NODE-02",
  "go-encoder-lifecycle-keeps-role-and-resumes",
  "loopback-tls-go-encoder-lifecycle-v1",
  "EncodeNode役が旧WSSを閉じて更新し、Roleを変えず次の接続世代へ移って失効時に停止する",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    let node: Awaited<ReturnType<typeof agent>> | undefined;
    let expectedExit = 1;
    try {
      const target = await device("encoder-go-lifecycle");
      const operator = await context.mint("operator-local");
      assert.equal(
        (await context.register(target, operator, "encoder")).status,
        201,
      );
      const joinCode = await context.challenge(target, operator);
      const config = {
        target,
        joinCode,
        lifecycle: true,
        nodeRole: "encoder" as const,
      };
      node = await agent(context, config, tls.certificate);
      const joined = await node.wait((r) => r.state === "joined");
      await node.wait(
        (r) => r.state === "connected" && r.generation === joined.generation,
      );
      expectedExit = 0;
      const renewed = await node.wait(
        (r) =>
          r.state === "connected" &&
          r.generation === (joined.generation ?? 0) + 1,
        15_000,
      );
      assert.equal(renewed.rotations, 1);
      assert.equal(renewed.attempt, 2);
      const row = await state(context, target.nodeId);
      assert.equal(row.node_role, "encoder");
      assert.equal(row.credential_version, renewed.generation);
      assert.equal(row.session_epoch, 2);
      assert.equal(capabilities(row.capabilities).resume?.lastSessionEpoch, 1);
      await revoke(context, target.nodeId, operator);
      assert.equal(
        (await node.wait((r) => r.done === true)).code,
        "credentials",
      );
      assert.equal(context.egress, 0);
    } finally {
      try {
        await node?.close(expectedExit);
      } finally {
        await context.close();
      }
    }
  },
);

scenario(
  "SEC-02",
  "go-encoder-restart-denies-role-confusion",
  "loopback-tls-go-encoder-process-role-v1",
  "親のメモリだけで資格を渡し、別Roleの履歴利用をHTTP前に拒否して正しいRoleなら別Goで復元する",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    const checkpointId = randomBytes(16).toString("hex");
    const directory = join(tmpdir(), "telestra-checkpoint-" + checkpointId);
    mkdirSync(directory, { mode: 0o700 });
    let node: Awaited<ReturnType<typeof agent>> | undefined;
    let expectedExit = 1;
    try {
      const target = await device("encoder-go-restart");
      const operator = await context.mint("operator-local");
      assert.equal(
        (await context.register(target, operator, "encoder")).status,
        201,
      );
      const joinCode = await context.challenge(target, operator);
      const config = {
        target,
        joinCode,
        nodeRole: "encoder" as const,
        processMode: "persist-run" as const,
        checkpointId,
      };
      node = await agent(context, config, tls.certificate);
      const rotated = await node.wait((r) => r.state === "rotated");
      await node.wait((r) => r.state === "connected");
      expectedExit = 0;
      const credential = await node.credential(rotated.generation ?? 0);
      await node.close();
      node = undefined;
      // Roleは受信Tokenから推測しない。既存履歴と異なる構成なら署名やHTTPより前に停止する。
      const wrong = {
        target,
        credential,
        nodeRole: "tuner" as const,
        processMode: "restore-run" as const,
        checkpointId,
      };
      node = await agent(context, wrong, tls.certificate);
      expectedExit = 1;
      assert.equal((await node.wait((r) => r.done === true)).code, "journal");
      await node.close(1);
      node = undefined;
      const rejected = await state(context, target.nodeId);
      assert.equal(rejected.session_epoch, 1);
      assert.equal(rejected.credential_version, rotated.generation);
      assert.equal(rejected.node_role, "encoder");
      const counts = await context.database
        .prepare(
          "SELECT COUNT(*) AS count FROM identity_audit WHERE node_id=? AND action IN ('node.join','node.rotate')",
        )
        .bind(target.nodeId)
        .first<{ count: number }>();
      assert.equal(counts?.count, 2);
      const restored = {
        target,
        credential,
        nodeRole: "encoder" as const,
        processMode: "restore-run" as const,
        checkpointId,
      };
      node = await agent(context, restored, tls.certificate);
      assert.equal(
        (await node.wait((r) => r.state === "restored")).generation,
        rotated.generation,
      );
      await node.wait((r) => r.state === "connected");
      expectedExit = 0;
      const row = await state(context, target.nodeId);
      assert.equal(row.session_epoch, 2);
      assert.equal(row.node_role, "encoder");
      assert.equal(capabilities(row.capabilities).resume?.lastSessionEpoch, 1);
      await revoke(context, target.nodeId, operator);
      assert.equal(
        (await node.wait((r) => r.done === true)).code,
        "credentials",
      );
      assert.equal(context.egress, 0);
    } finally {
      try {
        await node?.close(expectedExit);
      } finally {
        await context.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);
