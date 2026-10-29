// 実loopback HTTPで本文を途中停止させ、408とD1の未更新・次の正常要求を確認する。
import assert from "node:assert/strict";
import { request } from "node:http";
import { before, after } from "node:test";
import { fixture, origin, tenantId } from "./helper.ts";
import { enroll, openNode } from "./socket.ts";
import { scenario } from "../evidence.ts";

let context: Awaited<ReturnType<typeof fixture>>;
before(async () => {
  context = await fixture();
});
after(async () => {
  await context?.close();
});

// 接続先は自分で起動したnumeric loopbackへ固定し、資格や上流例外を診断出力へ渡さない。
async function post(
  token: string,
  chunks: readonly Uint8Array[],
  options: { stalled?: boolean; encoding?: string } = {},
): Promise<{ status: number; code: unknown; elapsed: number }> {
  const endpoint = await context.mf.ready;
  assert.equal(endpoint.hostname, "127.0.0.1");
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const pending = request({
      hostname: "127.0.0.1",
      port: endpoint.port,
      path: "/reservations",
      method: "POST",
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: origin,
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
        ...(options.encoding ? { "Content-Encoding": options.encoding } : {}),
      },
    });
    const timeout = setTimeout(() => {
      pending.destroy();
      reject(new Error("ローカルHTTPの本文試験が期限内に完了しません。"));
    }, 8000);
    pending.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("ローカルHTTPの本文試験を確認できません。"));
    });
    pending.on("response", (response) => {
      let size = 0;
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => {
        size += part.length;
        if (size > 2048) pending.destroy();
        else parts.push(part);
      });
      response.on("error", () => {
        clearTimeout(timeout);
        pending.destroy();
        reject(new Error("ローカルHTTPの拒否応答を確認できません。"));
      });
      response.on("end", () => {
        clearTimeout(timeout);
        pending.destroy();
        try {
          const value = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
            code?: unknown;
          };
          resolve({
            status: response.statusCode ?? 0,
            code: value.code,
            elapsed: performance.now() - started,
          });
        } catch {
          reject(new Error("ローカルHTTPの拒否応答が不正です。"));
        }
      });
    });
    for (const chunk of chunks) pending.write(chunk);
    if (!options.stalled) pending.end();
  });
}

scenario(
  "SEC-10",
  "worker-body-stall-rejects-before-d1-write",
  "native-http-chunked-body-v1",
  "送信途中の停止を408で拒否し、過大・不正UTF-8・圧縮もD1へ保存せず、正常な再操作は通す",
  async () => {
    const token = await context.mint("recorder-local");
    const denied = await post(token, [Buffer.from('{"reservationId":')], {
      stalled: true,
    });
    assert.equal(denied.status, 408);
    assert.equal(denied.code, "BODY_TIMEOUT");
    assert.ok(denied.elapsed >= 4900 && denied.elapsed < 8000);
    for (const [chunks, options, code, status] of [
      [[new Uint8Array(8193)], {}, "TOO_LARGE", 413],
      [[Uint8Array.of(0xff)], {}, "INVALID_JSON", 400],
      [[Buffer.from("{}")], { encoding: "gzip" }, "CONTENT_ENCODING", 415],
    ] as const) {
      const result = await post(token, chunks, options);
      assert.equal(result.status, status);
      assert.equal(result.code, code);
    }
    const count = await context.database
      .prepare(
        "SELECT COUNT(*) AS count FROM reservations WHERE environment=? AND tenant_id=?",
      )
      .bind("development", tenantId)
      .first<{ count: number }>();
    assert.equal(count?.count, 0);
    const valid = await context.browser("/reservations", token, {
      method: "POST",
      body: {
        reservationId: "reservation-after-stall",
        serviceKey: "service-synthetic",
        startsAt: new Date((context.now() + 600) * 1000).toISOString(),
        endsAt: new Date((context.now() + 1200) * 1000).toISOString(),
      },
    });
    assert.equal(valid.status, 202);
    assert.equal(context.egress, 0);
  },
);

scenario(
  "CORE-02",
  "worker-do-reserialized-body-length",
  "padded-command-forwarding-v1",
  "JSONをDOへ再シリアライズする際は元の長さを転用せず、同じ制御命令を正常に配送する",
  async () => {
    const enrolled = await enroll(context, "tuner-padded-body");
    const connection = await openNode(context, enrolled);
    try {
      await connection.hello();
      const command = {
        commandId: "command-padded-body",
        type: "capture.cancel",
        payload: { recordingId: "rec-owned-01", attemptId: "attempt-local-01" },
        expiresAt: new Date((context.now() + 25) * 1000).toISOString(),
      };
      const raw = "  " + JSON.stringify(command, null, 2) + "\n";
      const response = await context.mf.dispatchFetch(
        `http://localhost/nodes/${enrolled.target.nodeId}/commands`,
        {
          method: "POST",
          body: raw,
          headers: {
            Origin: origin,
            Authorization: `Bearer ${enrolled.operator}`,
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(raw)),
          },
        },
      );
      assert.equal(response.status, 202);
      assert.equal((await connection.next()).messageId, command.commandId);
      const repeated = await context.browser(
        `/nodes/${enrolled.target.nodeId}/commands`,
        enrolled.operator,
        { method: "POST", body: command },
      );
      assert.equal(repeated.status, 200);
    } finally {
      connection.socket.close(1000, "試験終了");
    }
  },
);
