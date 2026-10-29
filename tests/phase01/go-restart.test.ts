// 異なるGoプロセスで同じ非秘密履歴を使い、親のメモリから渡す資格だけで復元する。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, device } from "./helper.ts";
import { agent, tlsMaterial } from "./go-agent.ts";
import { scenario } from "../evidence.ts";
import { rotateBarrier } from "./rotate-barrier.ts";
import { exportJWK } from "jose";

scenario(
  "NODE-02",
  "go-process-restart-restores-credential-and-epoch",
  "loopback-tls-workerd-two-go-processes-v1",
  "別のGoプロセスが専用の非秘密履歴とメモリ供給の資格を照合し、接続世代を引き継ぐ",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    const checkpointId = randomBytes(16).toString("hex");
    const directory = join(tmpdir(), "telestra-checkpoint-" + checkpointId);
    mkdirSync(directory, { mode: 0o700 });
    let first: Awaited<ReturnType<typeof agent>> | undefined,
      second: Awaited<ReturnType<typeof agent>> | undefined;
    try {
      const target = await device("tuner-go-process-01");
      const operator = await context.mint("operator-local");
      assert.equal((await context.register(target, operator)).status, 201);
      const joinCode = await context.challenge(target, operator);
      first = await agent(
        context,
        { target, joinCode, processMode: "persist-run", checkpointId },
        tls.certificate,
      );
      const joined = await first.wait((r) => r.state === "joined");
      const obsolete = await first.credential(joined.generation ?? 0);
      const rotated = await first.wait((r) => r.state === "rotated");
      await first.wait((r) => r.state === "connected");
      const credential = await first.credential(rotated.generation ?? 0);
      await first.close();
      first = undefined;
      // 旧世代と別鍵は、新しいプロセスでも接続前に拒否する。拒否後も履歴を削除しない。
      for (const denied of [
        { target, credential: obsolete, code: "credentials" },
        { target: await device(target.nodeId), credential, code: "journal" },
      ]) {
        second = await agent(
          context,
          {
            ...denied,
            processMode: "restore-run",
            checkpointId,
          },
          tls.certificate,
        );
        assert.equal(
          (await second.wait((r) => r.done === true)).code,
          denied.code,
        );
        await second.close(1);
        second = undefined;
      }
      const state = readFileSync(
        join(directory, "agent-state/control.json"),
        "utf8",
      );
      assert.equal(
        state.includes(credential.accessToken),
        false,
        "資格をファイルへ保存しました。",
      );
      const key = await exportJWK(target.privateKey);
      assert.equal(
        state.includes(key.d ?? "missing-key"),
        false,
        "秘密鍵をファイルへ保存しました。",
      );
      assert.equal(
        state.includes(joinCode),
        false,
        "参加コードをファイルへ保存しました。",
      );
      second = await agent(
        context,
        { target, credential, processMode: "restore-run", checkpointId },
        tls.certificate,
      );
      const restored = await second.wait((r) => r.state === "restored");
      assert.equal(restored.generation, rotated.generation);
      await second.wait((r) => r.state === "connected");
      const row = await context.database
        .prepare(
          "SELECT credential_version,session_epoch FROM nodes WHERE node_id=?",
        )
        .bind(target.nodeId)
        .first<{ credential_version: number; session_epoch: number }>();
      assert.deepEqual(row, {
        credential_version: rotated.generation,
        session_epoch: 2,
      });
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
        (await second.wait((r) => r.done === true)).code,
        "credentials",
      );
      assert.equal(context.egress, 0);
    } finally {
      try {
        await first?.close();
        await second?.close();
      } finally {
        await context.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);

scenario(
  "SEC-02",
  "go-process-kill-after-worker-rotation-requires-rejoin",
  "loopback-tls-workerd-rotation-barrier-sigkill-v1",
  "Workerの更新成立後にGoを強制終了し、別プロセスがpending履歴と旧資格で復元・接続しない",
  async () => {
    const tls = tlsMaterial();
    const context = await fixture(tls);
    const barrier = await rotateBarrier(context, tls);
    const checkpointId = randomBytes(16).toString("hex");
    const directory = join(tmpdir(), "telestra-checkpoint-" + checkpointId);
    mkdirSync(directory, { mode: 0o700 });
    let first: Awaited<ReturnType<typeof agent>> | undefined,
      second: Awaited<ReturnType<typeof agent>> | undefined;
    try {
      const target = await device("tuner-go-crash-01");
      const operator = await context.mint("operator-local");
      assert.equal((await context.register(target, operator)).status, 201);
      const joinCode = await context.challenge(target, operator);
      first = await agent(
        context,
        {
          target,
          joinCode,
          processMode: "persist-run",
          checkpointId,
          endpoint: barrier.endpoint,
        },
        tls.certificate,
      );
      const joined = await first.wait((r) => r.state === "joined");
      const credential = await first.credential(joined.generation ?? 0);
      await barrier.wait();
      const before = await context.database
        .prepare(
          "SELECT credential_version,session_epoch FROM nodes WHERE node_id=?",
        )
        .bind(target.nodeId)
        .first<{ credential_version: number; session_epoch: number }>();
      assert.deepEqual(before, {
        credential_version: credential.credentialVersion + 1,
        session_epoch: 0,
      });
      first.crash();
      await first.close("SIGKILL");
      first = undefined;
      const state = readFileSync(
        join(directory, "agent-state/control.json"),
        "utf8",
      );
      const metadata = JSON.parse(state) as {
        enrollment: { phase: string; credentialVersion: number };
      };
      assert.equal(metadata.enrollment.phase, "pending");
      assert.equal(
        metadata.enrollment.credentialVersion,
        credential.credentialVersion,
      );
      assert.equal(
        state.includes(credential.accessToken),
        false,
        "資格をファイルへ保存しました。",
      );
      second = await agent(
        context,
        {
          target,
          credential,
          processMode: "restore-run",
          checkpointId,
          endpoint: barrier.endpoint,
        },
        tls.certificate,
      );
      assert.equal(
        (await second.wait((r) => r.done === true)).code,
        "recovery-required",
      );
      await second.close(1);
      second = undefined;
      const after = await context.database
        .prepare(
          "SELECT credential_version,session_epoch FROM nodes WHERE node_id=?",
        )
        .bind(target.nodeId)
        .first<{ credential_version: number; session_epoch: number }>();
      assert.deepEqual(after, before);
      assert.equal(barrier.requests, 2);
      assert.equal(context.egress, 0);
    } finally {
      try {
        await first?.close();
        await second?.close();
      } finally {
        try {
          await barrier.close();
        } finally {
          await context.close();
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  },
);
