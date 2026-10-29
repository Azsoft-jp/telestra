// 実際のローカルWebSocketとD1・DOで、接続世代、署名、再送、有限のACK窓を検証する。
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { fixture, device, origin } from "./helper.ts";
import { enroll, openNode } from "./socket.ts";
import type { Enrolled } from "./socket.ts";
import type { Fixture } from "./helper.ts";
import { scenario } from "../evidence.ts";

// 命令は固定された構造だけで送る。任意のShell、URL、媒体バイトを渡す入口は設けない。
function cancellation(context: Fixture, suffix: string) {
  return {
    commandId: `command-${suffix}`,
    type: "capture.cancel",
    payload: { recordingId: "rec-owned-01", attemptId: "attempt-local-01" },
    expiresAt: new Date((context.now() + 25) * 1000).toISOString(),
  };
}
function dispatch(context: Fixture, enrolled: Enrolled, body: unknown) {
  return context.browser(
    `/nodes/${enrolled.target.nodeId}/commands`,
    enrolled.operator,
    { method: "POST", body },
  );
}

scenario(
  "NODE-02",
  "do-generation-heartbeat-resumption",
  "local-workerd-d1-do-v1",
  "接続世代を進め、未ACK命令を同じIDで再送し、再起動後もD1の録画台帳とDOの待ち行列を保持する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-resumption-01");
      const first = await openNode(context, enrolled);
      await first.hello();
      await first.send("node.heartbeat", { uptimeSeconds: 10, spoolBytes: 0 });
      assert.equal((await first.next()).type, "control.receipt");
      const row = await context.database
        .prepare("SELECT capabilities,last_seen FROM nodes WHERE node_id=?")
        .bind(enrolled.target.nodeId)
        .first<{ capabilities: string; last_seen: number }>();
      assert.equal(JSON.parse(row!.capabilities).backend, "synthetic");
      assert.ok(row!.last_seen > 0);
      const command = cancellation(context, "resume-01");
      assert.equal((await dispatch(context, enrolled, command)).status, 202);
      assert.equal((await first.next()).messageId, command.commandId);
      const second = await openNode(context, enrolled);
      assert.equal(await first.closeCode(), 1008);
      assert.ok(second.sessionEpoch > first.sessionEpoch);
      if (second.ready.type !== "session.ready")
        throw new Error("接続通知の型が不正です。");
      assert.equal(second.ready.payload.resumed, true);
      await second.hello(first.sessionEpoch);
      const resumed = await second.next();
      assert.equal(resumed.messageId, command.commandId);
      assert.equal(resumed.sessionEpoch, second.sessionEpoch);
      await second.send(
        "command.ack",
        { accepted: false, code: "not implemented" },
        { envelope: { correlationId: command.commandId } },
      );
      assert.equal((await second.next()).type, "control.receipt");
      const repeated = await dispatch(context, enrolled, command);
      assert.equal(repeated.status, 200);
      const result = (await repeated.json()) as {
        state: string;
        result: { accepted: boolean; code: string };
      };
      assert.equal(result.state, "acknowledged");
      assert.deepEqual(result.result, {
        accepted: false,
        code: "not implemented",
      });
      assert.equal(
        (
          await dispatch(context, enrolled, {
            ...command,
            payload: { ...command.payload, attemptId: "attempt-other-01" },
          })
        ).status,
        409,
      );
      const persistent = cancellation(context, "persistent-01");
      assert.equal((await dispatch(context, enrolled, persistent)).status, 202);
      assert.equal((await second.next()).messageId, persistent.commandId);
      await context.restart();
      const third = await openNode(context, enrolled);
      assert.ok(third.sessionEpoch > second.sessionEpoch);
      await third.hello(second.sessionEpoch);
      assert.equal((await third.next()).messageId, persistent.commandId);
      const recording = await context.browser(
        "/recordings/rec-owned-01",
        await context.mint("recorder-local"),
      );
      assert.equal(recording.status, 200);
      assert.deepEqual(
        ((await recording.json()) as { attemptIds: string[] }).attemptIds,
        ["attempt-local-01"],
      );
      assert.equal(context.egress, 0);
      third.socket.close(1000, "試験終了");
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-03",
  "ws-signed-frame-denials",
  "local-jws-frame-fixtures-v1",
  "未知命令、誤署名、期限切れ、旧世代、別家庭・環境、URL鍵、Replay、役割偽装を拒否する",
  async () => {
    const context = await fixture();
    try {
      const counterfeit = await device("counterfeit-signer");
      const cases = [
        {
          name: "unknown-command",
          type: "shell.exec",
          payload: { command: "id" },
        },
        {
          name: "extra-payload",
          payload: {
            uptimeSeconds: 1,
            spoolBytes: 0,
            url: "http://127.0.0.1/private",
          },
        },
        { name: "bad-signature", options: { signer: counterfeit } },
        {
          name: "expired",
          options: {
            claims: { iat: context.now() - 20, exp: context.now() - 1 },
          },
        },
        {
          name: "wrong-tenant",
          options: { claims: { tenantId: "foreign-household" } },
        },
        {
          name: "wrong-environment",
          options: { claims: { environment: "staging" } },
        },
        {
          name: "wrong-credential",
          options: { claims: { credentialVersion: 999 } },
        },
        {
          name: "wrong-direction",
          options: { claims: { direction: "control-to-node" } },
        },
        { name: "wrong-purpose", options: { header: { typ: "tv-node+jwt" } } },
        {
          name: "remote-key",
          options: { header: { jku: "http://192.0.2.1/key" } },
        },
        { name: "old-epoch", options: { envelope: { sessionEpoch: 0 } } },
        { name: "wrong-kind", options: { envelope: { kind: "command" } } },
        {
          name: "injected-command",
          type: "capture.cancel",
          payload: {
            recordingId: "rec-owned-01",
            attemptId: "attempt-local-01",
          },
        },
      ];
      for (const [index, invalid] of cases.entries()) {
        const enrolled = await enroll(context, `tuner-denial-${index}`);
        const client = await openNode(context, enrolled);
        await client.hello();
        await client.send(
          invalid.type ?? "node.heartbeat",
          invalid.payload ?? { uptimeSeconds: 1, spoolBytes: 0 },
          invalid.options,
        );
        assert.equal(await client.closeCode(), 1008, invalid.name);
      }
      const enrolled = await enroll(context, "tuner-replay-01");
      const client = await openNode(context, enrolled);
      await client.hello();
      const packet = await client.packet("node.heartbeat", {
        uptimeSeconds: 5,
        spoolBytes: 0,
      });
      client.socket.send(packet);
      assert.equal((await client.next()).type, "control.receipt");
      client.socket.send(packet);
      assert.equal(await client.closeCode(), 1008);
      for (const [index, hello] of [
        {
          agentVersion: "test",
          nodeRole: "encoder",
          backend: "encoder",
          capabilities: ["encode"],
          maxConcurrentJobs: 1,
        },
        {
          agentVersion: "test",
          nodeRole: "tuner",
          backend: "synthetic",
          capabilities: ["encode"],
          maxConcurrentJobs: 1,
        },
      ].entries()) {
        const target = await enroll(context, `tuner-role-${index}`);
        const connection = await openNode(context, target);
        await connection.send("node.hello", hello);
        assert.equal(await connection.closeCode(), 1008);
      }
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-03",
  "ws-size-binary-and-handshake-order",
  "local-frame-boundary-v1",
  "過大フレーム・Binary・未署名JSON・hello前のHeartbeatを拒否する",
  async () => {
    const context = await fixture();
    try {
      for (const [index, input] of [
        "x".repeat(16_385),
        new Uint8Array([0x47, 0x01]),
        JSON.stringify({ type: "node.hello" }),
      ].entries()) {
        const enrolled = await enroll(context, `tuner-frame-${index}`);
        const client = await openNode(context, enrolled);
        client.socket.send(input);
        assert.equal(
          await client.closeCode(),
          index === 0 ? 1009 : index === 1 ? 1003 : 1008,
        );
      }
      const enrolled = await enroll(context, "tuner-order-01");
      const client = await openNode(context, enrolled);
      await client.send("node.heartbeat", { uptimeSeconds: 0, spoolBytes: 0 });
      assert.equal(await client.closeCode(), 1008);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-04",
  "ws-browser-origin-credential-and-tls",
  "local-upgrade-boundary-v1",
  "Origin付きNode接続、Browser資格、Cookieだけの接続、平文・クエリ付き・Upgradeなしの要求を拒否する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-origin-01");
      for (const disallowed of [origin, "https://evil.example.test", "null"])
        assert.equal(
          (
            await context.mf.dispatchFetch(
              "https://control.example.test/agent",
              {
                headers: {
                  Upgrade: "websocket",
                  Origin: disallowed,
                  Authorization: `Bearer ${enrolled.credential.accessToken}`,
                },
              },
            )
          ).status,
          403,
        );
      assert.equal(
        (
          await context.mf.dispatchFetch("https://control.example.test/agent", {
            headers: {
              Upgrade: "websocket",
              Authorization: `Bearer ${await context.mint("viewer-local")}`,
            },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await context.mf.dispatchFetch("https://control.example.test/agent", {
            headers: { Upgrade: "websocket", Cookie: "session=synthetic" },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await context.mf.dispatchFetch("http://control.example.test/agent", {
            headers: {
              Upgrade: "websocket",
              Authorization: `Bearer ${enrolled.credential.accessToken}`,
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await context.mf.dispatchFetch(
            "https://control.example.test/agent?token=synthetic",
            {
              headers: {
                Upgrade: "websocket",
                Authorization: `Bearer ${enrolled.credential.accessToken}`,
              },
            },
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await context.mf.dispatchFetch("https://control.example.test/agent", {
            headers: {
              Authorization: `Bearer ${enrolled.credential.accessToken}`,
            },
          })
        ).status,
        426,
      );
    } finally {
      await context.close();
    }
  },
);

scenario(
  "NODE-01",
  "ws-rotation-revocation-and-expiry-close",
  "memory-credential-and-do-v1",
  "資格更新・失効で既存接続を閉じ、短命資格の期限切れもalarmで切断する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-revoke-ws-01");
      const first = await openNode(context, enrolled);
      await first.hello();
      const claims = context.decode(enrolled.credential.accessToken);
      const rotate = await context.agent(
        "/nodes/rotate",
        enrolled.credential.accessToken,
        {
          proof: await context.deviceProof(
            enrolled.target,
            "rotate",
            String(claims.jti),
          ),
        },
      );
      assert.equal(rotate.status, 200);
      assert.equal(await first.closeCode(), 1008);
      const updated = {
        ...enrolled,
        credential: (await rotate.json()) as Enrolled["credential"],
      };
      const second = await openNode(context, updated);
      await second.hello();
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
      assert.equal(await second.closeCode(), 1008);
      const temporary = await enroll(context, "tuner-expiry-ws-01");
      const base = context.decode(temporary.credential.accessToken);
      const expiring = await new SignJWT({
        ...base,
        iat: context.now(),
        exp: context.now() + 2,
      })
        .setProtectedHeader({
          alg: "EdDSA",
          kid: context.signer.publicJwk.kid,
          typ: "tv-node+jwt",
        })
        .sign(context.signer.privateKey);
      const third = await openNode(context, temporary, expiring);
      await third.hello();
      assert.equal(
        (
          await dispatch(
            context,
            temporary,
            cancellation(context, "credential-bound"),
          )
        ).status,
        202,
      );
      const bounded = await third.next();
      assert.ok(
        Date.parse(bounded.expiresAt) / 1000 <=
          Number(context.decode(expiring).exp),
      );
      assert.equal(await third.closeCode(), 1008);
      const status = await context.browser(
        `/nodes/${temporary.target.nodeId}/connection`,
        temporary.operator,
      );
      assert.equal(
        ((await status.json()) as { state: string }).state,
        "disconnected",
      );
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-10",
  "ws-finite-ack-window-and-role",
  "local-bounded-command-window-v1",
  "同時送信でも未ACK8件で制限し、ACK後に枠を戻す。権限不足・役割違い・未知命令を拒否する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-window-01");
      const client = await openNode(context, enrolled);
      await client.hello();
      const commands = Array.from({ length: 10 }, (_, i) =>
        cancellation(context, `window-${i}`),
      );
      const responses = await Promise.all(
        commands.map((command) => dispatch(context, enrolled, command)),
      );
      assert.equal(responses.filter((r) => r.status === 202).length, 8);
      assert.equal(responses.filter((r) => r.status === 429).length, 2);
      const received = [];
      for (let i = 0; i < 8; i++) received.push(await client.next());
      const acknowledged = received[0]!;
      await client.send(
        "command.ack",
        { accepted: false, code: "not implemented" },
        { envelope: { correlationId: acknowledged.messageId } },
      );
      assert.equal((await client.next()).type, "control.receipt");
      assert.equal(
        (await dispatch(context, enrolled, cancellation(context, "after-ack")))
          .status,
        202,
      );
      assert.equal((await client.next()).messageId, "command-after-ack");
      assert.equal(
        (
          await dispatch(context, enrolled, {
            ...cancellation(context, "inject"),
            type: "shell.exec",
            payload: { command: "id" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await context.browser(
            `/nodes/${enrolled.target.nodeId}/commands`,
            await context.mint("viewer-local"),
            { method: "POST", body: cancellation(context, "denied") },
          )
        ).status,
        403,
      );
      const encoder = await enroll(context, "encoder-window-01", "encoder");
      const encodeClient = await openNode(context, encoder);
      await encodeClient.send("node.hello", {
        agentVersion: "test",
        nodeRole: "encoder",
        backend: "encoder",
        capabilities: ["mock-encode"],
        maxConcurrentJobs: 1,
      });
      assert.equal((await encodeClient.next()).type, "control.receipt");
      assert.equal(
        (await dispatch(context, encoder, cancellation(context, "wrong-role")))
          .status,
        403,
      );
      client.socket.close(1000, "試験終了");
      encodeClient.socket.close(1000, "試験終了");
    } finally {
      await context.close();
    }
  },
);

scenario(
  "CORE-02",
  "signed-capture-start-stays-unimplemented",
  "synthetic-permit-structure-only-v1",
  "capture.startの署名付き配送を確認し、構造だけのPermitを実録画成功として扱わない",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-start-wire-01");
      const client = await openNode(context, enrolled);
      await client.hello();
      const now = new Date(context.now() * 1000).toISOString();
      const end = new Date((context.now() + 300) * 1000).toISOString();
      const permit = {
        schemaVersion: 1,
        keyId: "synthetic-key",
        algorithm: "Ed25519",
        signature: "s".repeat(64),
        claims: {
          permitId: "permit-local-01",
          nodeId: enrolled.target.nodeId,
          recordingId: "recording-local-01",
          attemptId: "attempt-local-01",
          serviceKey: "service-local-01",
          captureScope: "service-filtered",
          issuedAt: now,
          notBefore: now,
          notAfter: end,
          offlineAllowedUntil: end,
          spoolMaxBytes: 1024,
          storageGrantRef: "grant-local-01",
        },
      };
      const input = {
        ...cancellation(context, "start-wire-01"),
        type: "capture.start",
        payload: { permit },
      };
      assert.equal(
        (
          await dispatch(context, enrolled, {
            ...input,
            payload: {
              permit: {
                ...permit,
                claims: { ...permit.claims, nodeId: "tuner-other-01" },
              },
            },
          })
        ).status,
        400,
      );
      assert.equal((await dispatch(context, enrolled, input)).status, 202);
      const start = await client.next();
      assert.equal(start.type, "capture.start");
      await client.send(
        "command.ack",
        { accepted: false, code: "not implemented" },
        { envelope: { correlationId: input.commandId } },
      );
      assert.equal((await client.next()).type, "control.receipt");
      const outcome = await dispatch(context, enrolled, input);
      assert.deepEqual(((await outcome.json()) as { result: object }).result, {
        accepted: false,
        code: "not implemented",
      });
      const attempts = await context.database
        .prepare(
          "SELECT payload FROM recordings WHERE recording_id='rec-owned-01'",
        )
        .first<{ payload: string }>();
      assert.deepEqual(JSON.parse(attempts!.payload).attemptIds, [
        "attempt-local-01",
      ]);
      client.socket.close(1000, "試験終了");
    } finally {
      await context.close();
    }
  },
);

scenario(
  "NODE-02",
  "ws-idle-alarm-disconnect",
  "local-do-alarm-v1",
  "有効な資格が残っていても、Heartbeatが45秒途絶えた接続をalarmで切断する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-idle-01");
      const client = await openNode(context, enrolled);
      await client.hello();
      const started = Date.now();
      assert.equal(await client.closeCode(50_000), 1008);
      assert.ok(Date.now() - started >= 43_000);
      assert.ok(
        Number(context.decode(enrolled.credential.accessToken).exp) >
          context.now(),
      );
      const status = await context.browser(
        `/nodes/${enrolled.target.nodeId}/connection`,
        enrolled.operator,
      );
      assert.equal(
        ((await status.json()) as { state: string }).state,
        "disconnected",
      );
    } finally {
      await context.close();
    }
  },
);

scenario(
  "NODE-01",
  "ws-handshake-device-proof-replay",
  "memory-device-proof-and-do-storage-v1",
  "Node資格だけの接続、別端末の証明、再利用した証明を拒否し、既存接続を維持する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-connect-proof-01");
      const token = enrolled.credential.accessToken;
      const claims = context.decode(token);
      const proof = await context.deviceProof(
        enrolled.target,
        "connect",
        String(claims.jti),
      );
      const client = await openNode(context, enrolled, token, proof);
      await client.hello();
      const counterfeit = await device(enrolled.target.nodeId);
      for (const invalid of [
        undefined,
        await context.deviceProof(counterfeit, "connect", String(claims.jti)),
        proof,
      ]) {
        const response = await context.mf.dispatchFetch(
          "https://control.example.test/agent",
          {
            headers: {
              Upgrade: "websocket",
              Authorization: `Bearer ${token}`,
              ...(invalid !== undefined
                ? { "X-TV-Device-Proof": invalid }
                : {}),
            },
          },
        );
        assert.equal(response.status, 401);
      }
      await client.send("node.heartbeat", { uptimeSeconds: 1, spoolBytes: 0 });
      assert.equal((await client.next()).type, "control.receipt");
      await context.restart();
      const replayAfterRestart = await context.mf.dispatchFetch(
        "https://control.example.test/agent",
        {
          headers: {
            Upgrade: "websocket",
            Authorization: `Bearer ${token}`,
            "X-TV-Device-Proof": proof,
          },
        },
      );
      assert.equal(replayAfterRestart.status, 401);
      const restored = await openNode(context, enrolled);
      await restored.hello(client.sessionEpoch);
      restored.socket.close(1000, "試験終了");
    } finally {
      await context.close();
    }
  },
);
