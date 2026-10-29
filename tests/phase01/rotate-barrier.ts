// join/rotateだけをローカルWorkerへ渡し、更新成立後の応答を止める障害注入用TLSサーバー。
// 任意URLの中継、動画転送、外部通信、資格本文のログ出力は行わない。
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Fixture } from "./helper.ts";

export async function rotateBarrier(
  context: Fixture,
  tls: { certificate: string; key: string },
) {
  let invalid = false,
    requests = 0;
  let release: () => void = () => {};
  const processed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Set<ServerResponse>();
  const forward = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (
      request.method !== "POST" ||
      (request.url !== "/nodes/join" && request.url !== "/nodes/rotate") ||
      request.headers["content-type"] !== "application/json" ||
      (request.headers.authorization !== undefined &&
        request.headers.authorization.length > 8192)
    )
      throw new Error("障害注入対象外の要求です。");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error("要求の形式が不正です。");
      size += chunk.length;
      if (size > 8192) throw new Error("要求の上限を超えました。");
      chunks.push(chunk);
    }
    requests++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (request.headers.authorization)
      headers.Authorization = request.headers.authorization;
    const result = await context.mf.dispatchFetch(
      "http://localhost" + request.url,
      {
        method: "POST",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      },
    );
    if (request.url === "/nodes/rotate") {
      // Workerが世代を確定してから応答本文を破棄する。Goへ新資格を渡す前に親が終了させる。
      if (result.status !== 200)
        throw new Error("Workerの更新成立を確認できません。");
      await result.body?.cancel();
      held.add(response);
      response.once("close", () => held.delete(response));
      release();
      return;
    }
    const body = await result.text();
    if (result.status !== 200 || Buffer.byteLength(body) > 16_384)
      throw new Error("参加応答の形式が不正です。");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(body);
  };
  const server = createServer(
    { cert: tls.certificate, key: tls.key },
    (request, response) => {
      void forward(request, response).catch(() => {
        invalid = true;
        response.destroy();
      });
    },
  );
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(new Error("障害注入サーバーを開始できません。")),
    );
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("試験の接続先が不正です。");
  return {
    endpoint: `wss://127.0.0.1:${address.port}/agent`,
    get requests() {
      return requests;
    },
    wait: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          processed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Workerの更新が時間内に成立しません。")),
              5000,
            );
          }),
        ]);
        if (invalid) throw new Error("障害注入の通信が不正です。");
      } finally {
        clearTimeout(timer);
      }
    },
    close: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(new Error("障害注入サーバーを終了できません。"));
          else resolve();
        }),
      );
      if (invalid) throw new Error("障害注入の通信に失敗しました。");
    },
  };
}
