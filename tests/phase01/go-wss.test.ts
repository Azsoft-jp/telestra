// GoからローカルWorkerへTLS検証付きで接続し、IPCの鍵や資格を証跡へ残さず検証する。
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exportJWK } from "jose";
import { fixture, tenantId, device } from "./helper.ts";
import type { Fixture } from "./helper.ts";
import { enroll } from "./socket.ts";
import type { Enrolled } from "./socket.ts";
import { scenario } from "../evidence.ts";

const directory = mkdtempSync(join(tmpdir(), "tv-go-wss-test-"));
const executable = join(directory, "controlfixture");
const environment = {
  ...process.env,
  GOTOOLCHAIN: "local",
  GOPROXY: "off",
  GOSUMDB: "off",
};

// 固定したfixtureコマンドを構築する。引数や出力へ秘密値を含めない。
before(() => {
  const built = spawnSync(
    "go",
    ["build", "-o", executable, "./nodes/tuner/cmd/controlfixture"],
    { encoding: "utf8", env: environment, timeout: 30_000 },
  );
  assert.equal(built.status, 0, "GoのWSS試験コマンドを構築できません。");
});
after(() => rmSync(directory, { recursive: true, force: true }));

function tlsMaterial(): { certificate: string; key: string } {
  const result = spawnSync(executable, [], {
    input: JSON.stringify({ mode: "tls-material" }),
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16_384,
    env: environment,
  });
  assert.equal(result.status, 0, "試験用のTLS証明書を生成できません。");
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("試験用のTLS応答を解析できません。");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("certificate" in value) ||
    typeof value.certificate !== "string" ||
    !("key" in value) ||
    typeof value.key !== "string"
  )
    throw new Error("試験用のTLS応答の形式が不正です。");
  return { certificate: value.certificate, key: value.key };
}

interface Progress {
  rotations?: number;
  generation?: number;
  state?: string;
  attempt?: number;
  done?: boolean;
  attempts?: number;
  epoch?: number;
  code?: string;
}

// 子プロセスの出力は状態だけを受け付け、サイズ上限と有限の待機を設ける。
async function agent(
  context: Fixture,
  enrolled: Pick<Enrolled, "target"> & {
    credential?: Enrolled["credential"];
    joinCode?: string;
    lifecycle?: boolean;
    checkpoint?: boolean;
  },
  certificate: string,
) {
  const key = await exportJWK(enrolled.target.privateKey);
  const ready = await context.mf.ready;
  const endpoint = new URL("/agent", ready);
  endpoint.protocol = "wss:";
  const child = spawn(executable, [], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records: Progress[] = [];
  let buffer = "";
  let bytes = 0;
  let invalid = false;
  let ended = false;
  let exitCode: number | null = null;
  let outputError = false;
  const closed = new Promise<void>((resolve) =>
    child.once("close", (code) => {
      ended = true;
      exitCode = code;
      resolve();
    }),
  );
  child.on("error", () => {
    invalid = true;
  });
  child.stdin.on("error", () => {
    invalid = true;
  });
  child.stderr.on("data", () => {
    outputError = true;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16_384) {
      invalid = true;
      child.kill("SIGTERM");
      return;
    }
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      try {
        const value = JSON.parse(line) as unknown;
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          Object.keys(value).some(
            (field) =>
              ![
                "state",
                "rotations",
                "generation",
                "attempt",
                "done",
                "attempts",
                "epoch",
                "code",
              ].includes(field),
          )
        )
          invalid = true;
        else records.push(value as Progress);
      } catch {
        invalid = true;
      }
    }
  });
  child.stdin.end(
    JSON.stringify({
      mode: enrolled.checkpoint
        ? "checkpoint-run"
        : enrolled.lifecycle
          ? "lifecycle-run"
          : enrolled.joinCode
            ? "provision-run"
            : "run",
      endpoint: endpoint.toString(),
      rootPEM: certificate,
      issuer: context.bindings.TELESTRA_CONTROL_ISSUER,
      keys: [context.signer.publicJwk],
      identity: {
        NodeID: enrolled.target.nodeId,
        TenantID: tenantId,
        Environment: "development",
        Role: "tuner",
      },
      credential: enrolled.credential?.accessToken ?? "",
      joinCode: enrolled.joinCode ?? "",
      privateSeed: key.d,
      deviceKeyID: enrolled.target.publicJwk.kid,
    }),
  );
  const wait = async (
    predicate: (record: Progress) => boolean,
    timeout = 10_000,
  ): Promise<Progress> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (invalid || outputError) throw new Error("Goの状態通知が不正です。");
      const value = records.find(predicate);
      if (value) return value;
      if (ended) throw new Error("Goが期待した状態になる前に終了しました。");
      await delay(25);
    }
    throw new Error("Goの状態通知が時間内に届きません。");
  };
  return {
    wait,
    // 失敗時もGoを終了させ、Miniflareを破棄する前に接続を回収する。
    close: async () => {
      // 完了通知後はGoがsignal handlerを解放している場合があるため、SIGTERMを重ねない。
      // まだ実行中の場合だけ中断し、通知済みの場合も5秒の終了期限は維持する。
      if (!ended && !records.some((record) => record.done === true))
        child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("Goを終了できません。"));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(exitCode, 0, "GoのWSS試験プロセスが失敗しました。");
      assert.equal(
        invalid || outputError,
        false,
        "Goの通知または終了処理が不正です。",
      );
    },
  };
}

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
