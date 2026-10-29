// 試験用NodeはJWSを検証してから本文を読む。Tokenや鍵をassertionへ渡さない。
import assert from "node:assert/strict";
import { SignJWT, decodeJwt } from "jose";
import type { WebSocket as LocalSocket } from "miniflare";
import type { Fixture, Device } from "./helper.ts";
import { device, tenantId } from "./helper.ts";
import { verifyControl } from "../../packages/control-contracts/channel.ts";

// 参加は実際のHTTP境界を通し、D1の登録・一回限りの参加権利も使う。
export async function enroll(
  context: Fixture,
  nodeId: string,
  nodeRole: "tuner" | "encoder" = "tuner",
) {
  const target = await device(nodeId);
  const operator = await context.mint("operator-local");
  assert.equal(
    (await context.register(target, operator, nodeRole)).status,
    201,
  );
  const code = await context.challenge(target, operator);
  const joined = await context.agent("/nodes/join", "", {
    nodeId,
    code,
    proof: await context.deviceProof(target, "join", code),
  });
  assert.equal(joined.status, 200);
  const credential = (await joined.json()) as {
    accessToken: string;
    credentialVersion: number;
  };
  return { target, operator, credential };
}
export type Enrolled = Awaited<ReturnType<typeof enroll>>;

// 受信待ちは有限とし、タイムアウトしても受信本文や資格を例外へ含めない。
function inbox(socket: LocalSocket) {
  const messages: string[] = [];
  let waiter: ((value: string) => void) | undefined;
  let closeWaiter: (code: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    closeWaiter = resolve;
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    if (waiter) {
      const receive = waiter;
      waiter = undefined;
      receive(event.data);
    } else messages.push(event.data);
  });
  socket.addEventListener("close", (event) => closeWaiter(event.code));
  const next = () => {
    const message = messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = undefined;
        reject(new Error("制御の受信が時間内に完了しませんでした。"));
      }, 3000);
      waiter = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  };
  const closeCode = async (timeout = 4000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("接続の終了が時間内に完了しませんでした。")),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return { next, closeCode };
}

// 最初の世代値も公開鍵で検証し、Nodeから送るイベントを接続世代へ拘束する。
export async function openNode(
  context: Fixture,
  enrolled: Enrolled,
  token = enrolled.credential.accessToken,
  connectionProof?: string,
) {
  const proof =
    connectionProof ??
    (await context.deviceProof(
      enrolled.target,
      "connect",
      String(decodeJwt(token).jti),
    ));
  const response = await context.mf.dispatchFetch(
    "https://control.example.test/agent",
    {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${token}`,
        "X-TV-Device-Proof": proof,
      },
    },
  );
  assert.equal(response.status, 101);
  if (!response.webSocket)
    throw new Error("制御用WebSocketを取得できませんでした。");
  const socket = response.webSocket;
  const incoming = inbox(socket);
  socket.accept();
  const rawReady = await incoming.next();
  const untrusted = decodeJwt(rawReady) as {
    envelope?: { sessionEpoch?: unknown };
  };
  const sessionEpoch = untrusted.envelope?.sessionEpoch;
  assert.equal(typeof sessionEpoch, "number");
  const expected = {
    nodeId: enrolled.target.nodeId,
    tenantId,
    environment: "development",
    credentialVersion: enrolled.credential.credentialVersion,
    sessionEpoch: sessionEpoch as number,
    expiresAt: Number(decodeJwt(token).exp),
  };
  const verify = (raw: string) =>
    verifyControl(
      raw,
      { ...expected, direction: "control-to-node" },
      { keys: [context.signer.publicJwk] },
      context.bindings.TELESTRA_CONTROL_ISSUER,
      context.now(),
    );
  const ready = await verify(rawReady);
  assert.equal(ready.type, "session.ready");
  const packet = async (
    type: string,
    payload: unknown,
    options: {
      envelope?: Record<string, unknown>;
      claims?: Record<string, unknown>;
      header?: Record<string, unknown>;
      signer?: Device;
    } = {},
  ) => {
    const now = context.now();
    // 試験Nodeもサーバーと同じ資格期限を守り、固定30秒で期限を越えさせない。
    const expires = Math.min(now + 30, expected.expiresAt);
    const envelope = {
      protocolVersion: 1,
      messageId: crypto.randomUUID(),
      kind:
        type === "command.ack"
          ? "ack"
          : type.startsWith("capture.")
            ? "command"
            : "event",
      type,
      nodeId: enrolled.target.nodeId,
      sessionEpoch,
      issuedAt: new Date(now * 1000).toISOString(),
      expiresAt: new Date(expires * 1000).toISOString(),
      payload,
      ...options.envelope,
    };
    return new SignJWT({
      iss: enrolled.target.nodeId,
      aud: "tv-control-plane",
      sub: enrolled.target.nodeId,
      iat: now,
      exp: expires,
      jti: envelope.messageId,
      tenantId,
      environment: "development",
      nodeId: enrolled.target.nodeId,
      credentialVersion: enrolled.credential.credentialVersion,
      direction: "node-to-control",
      envelope,
      ...options.claims,
    })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: enrolled.target.publicJwk.kid,
        typ: "tv-control+jwt",
        ...options.header,
      })
      .sign((options.signer ?? enrolled.target).privateKey);
  };
  const next = async () => verify(await incoming.next());
  const send = async (
    type: string,
    payload: unknown,
    options: Parameters<typeof packet>[2] = {},
  ) => socket.send(await packet(type, payload, options));
  const hello = async (resume?: number) => {
    await send("node.hello", {
      agentVersion: "phase01-test",
      nodeRole: "tuner",
      backend: "synthetic",
      capabilities: ["capture", "epg-read"],
      maxConcurrentJobs: 1,
      ...(resume !== undefined ? { resume: { lastSessionEpoch: resume } } : {}),
    });
    assert.equal((await next()).type, "control.receipt");
  };
  return {
    socket,
    rawReady,
    nextRaw: incoming.next,
    ready,
    sessionEpoch: sessionEpoch as number,
    expected,
    packet,
    send,
    next,
    hello,
    closeCode: incoming.closeCode,
    verify,
  };
}
