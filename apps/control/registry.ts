// DOは接続と有限の制御待ち行列を保持する。予約・録画の正本はD1に残す。
import type { Env, NodeRow } from "./auth.ts";
import {
  node,
  nodeRow,
  nowSeconds,
  user,
  role,
  rateLimit,
  proof,
} from "./auth.ts";
import { validateControl } from "../../packages/control-contracts/index.ts";
import type { ControlMap } from "../../packages/control-contracts/index.ts";
import {
  validateEnvelope,
  verifyControl,
} from "../../packages/control-contracts/channel.ts";
import type {
  ChannelContext,
  ChannelEnvelope,
} from "../../packages/control-contracts/channel.ts";
import {
  parseJson,
  signControl,
  authFailure,
} from "../../packages/identity/index.ts";
import { BoundaryError } from "../../packages/contracts/error.ts";

interface Session extends ChannelContext {
  nodeRole: "tuner" | "encoder";
  expiresAt: number;
  connected: boolean;
  hello: boolean;
  lastSeen: number;
  bucket: number;
  count: number;
  seen: { id: string; expiresAt: number }[];
}
interface Command {
  input: ControlMap["DispatchCommand"];
  credentialVersion: number;
  state: "pending" | "acknowledged";
  result?: ControlMap["WsCommandAck"];
}
const maxPending = 8;
const maxHistory = 32;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// 各状態遷移を直列化し、署名検証中の別イベントが世代やACK窓を追い越さないようにする。
export class NodeRegistry {
  private ctx: DurableObjectState;
  private env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.setHibernatableWebSocketEventTimeout(10_000);
  }

  // DOへの転送先はWorkerが固定する。接続と管理操作はDO内でも再認証する。
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (path === "/connect" && request.method === "GET")
          return await this.connect(request);
        if (path === "/invalidate" && request.method === "POST") {
          // 認証情報を変更できる入口にはせず、D1と食い違う接続だけを閉じる。
          await this.live();
          return json({ state: "checked" });
        }
        const actor = await user(request, this.env);
        role(actor, ["operator", "admin"]);
        const session = await this.live();
        if (path === "/status" && request.method === "GET") {
          const previous = await this.ctx.storage.get<Session>("session");
          return json({
            state: session
              ? session.hello
                ? "connected"
                : "waiting-hello"
              : "disconnected",
            sessionEpoch: previous?.sessionEpoch ?? 0,
            pendingCommands: (await this.commands()).filter(
              (c) =>
                c.state === "pending" &&
                Date.parse(c.input.expiresAt) > Date.now(),
            ).length,
          });
        }
        if (path === "/commands" && request.method === "POST") {
          if (!session?.hello)
            throw new BoundaryError(
              "NODE_DISCONNECTED",
              "Nodeの接続を待っています。",
              409,
            );
          const input = validateControl(
            "DispatchCommand",
            parseJson(await request.text(), 8192),
          );
          return await this.dispatch(session, input);
        }
        throw new BoundaryError("NOT_FOUND", "この操作は利用できません。", 404);
      } catch (error) {
        return error instanceof BoundaryError
          ? json({ code: error.code, message: error.message }, error.status)
          : json(
              {
                code: "REGISTRY_UNAVAILABLE",
                message: "接続管理を利用できません。",
              },
              503,
            );
      }
    });
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      throw new BoundaryError(
        "UPGRADE_REQUIRED",
        "WebSocketで接続してください。",
        426,
      );
    const identity = await node(request, this.env);
    if (
      !this.ctx.id.equals(
        this.env.TELESTRA_REGISTRY.idFromName(
          `${this.env.TELESTRA_ENVIRONMENT}:${this.env.TELESTRA_TENANT_ID}:${identity.row.node_id}`,
        ),
      )
    )
      throw authFailure();
    await rateLimit(this.env, `connect:${identity.row.node_id}`, 12);
    // Bearerだけで既存接続を追い出せないよう、端末鍵の一回限りの証明も要求する。
    const device = await proof(
      this.env,
      identity.row,
      request.headers.get("X-TV-Device-Proof") ?? "",
      "connect",
      identity.claims.jti,
    );
    const used = (
      (await this.ctx.storage.get<{ id: string; expiresAt: number }[]>(
        "connectionProofs",
      )) ?? []
    ).filter((item) => item.expiresAt > nowSeconds());
    if (used.length >= 32 || used.some((item) => item.id === device.jti))
      throw authFailure();
    used.push({ id: device.jti, expiresAt: device.exp });
    // D1更新より先に消費する。途中で失敗した場合は新しい証明を作って再試行する。
    await this.ctx.storage.put("connectionProofs", used);
    const previous = await this.ctx.storage.get<Session>("session");
    const changed = await this.env.TELESTRA_DB.prepare(
      "UPDATE nodes SET session_epoch=session_epoch+1 WHERE environment=? AND tenant_id=? AND node_id=? AND status='active' AND credential_version=? AND session_epoch<9007199254740991 RETURNING session_epoch",
    )
      .bind(
        this.env.TELESTRA_ENVIRONMENT,
        this.env.TELESTRA_TENANT_ID,
        identity.row.node_id,
        identity.claims.credentialVersion,
      )
      .first<{ session_epoch: number }>();
    if (!changed) throw authFailure();
    this.closeSockets(1008, "新しい接続へ切り替えました。");
    const now = nowSeconds();
    const session: Session = {
      nodeId: identity.row.node_id,
      nodeRole: identity.row.node_role,
      tenantId: this.env.TELESTRA_TENANT_ID,
      environment: this.env.TELESTRA_ENVIRONMENT,
      credentialVersion: identity.claims.credentialVersion,
      sessionEpoch: changed.session_epoch,
      expiresAt: identity.claims.exp,
      connected: true,
      hello: false,
      lastSeen: now,
      bucket: Math.floor(now / 60),
      count: 0,
      seen: [],
    };
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ sessionEpoch: session.sessionEpoch });
    this.ctx.acceptWebSocket(pair[1]);
    await this.ctx.storage.put("session", session);
    await this.schedule(session);
    await this.send(
      pair[1],
      session,
      this.envelope(session, "session.ready", {
        heartbeatIntervalSeconds: 15,
        idleTimeoutSeconds: 45,
        resumed:
          previous !== undefined &&
          previous.credentialVersion === session.credentialVersion,
      }),
    );
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Cache-Control": "no-store" },
    });
  }

  // 毎フレームでD1の失効・資格世代・接続世代を再確認し、切断中の操作も拒否する。
  private async live(socket?: WebSocket): Promise<Session | undefined> {
    const session = await this.ctx.storage.get<Session>("session");
    if (!session?.connected) return undefined;
    const row = await nodeRow(this.env, session.nodeId);
    const attachment = socket?.deserializeAttachment() as
      { sessionEpoch?: unknown } | undefined;
    if (socket && attachment?.sessionEpoch !== session.sessionEpoch) {
      socket.close(1008, "古い接続世代です。");
      return undefined;
    }
    const now = nowSeconds();
    if (
      session.expiresAt <= now ||
      now - session.lastSeen >= (session.hello ? 45 : 10) ||
      row.status !== "active" ||
      row.credential_version !== session.credentialVersion ||
      row.session_epoch !== session.sessionEpoch
    ) {
      session.connected = false;
      await this.ctx.storage.put("session", session);
      this.closeSockets(1008, "接続の資格または期限が無効です。");
      return undefined;
    }
    return session;
  }

  // Binaryや過大フレームは署名解析より先に拒否し、媒体を制御経路へ載せない。
  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (typeof message !== "string") {
          socket.close(1003, "制御はテキスト形式だけです。");
          return;
        }
        if (new TextEncoder().encode(message).byteLength > 16_384) {
          socket.close(1009, "制御のサイズ上限を超えています。");
          return;
        }
        const session = await this.live(socket);
        if (!session) {
          socket.close(1008, "有効な接続がありません。");
          return;
        }
        const now = nowSeconds();
        const bucket = Math.floor(now / 60);
        session.count = session.bucket === bucket ? session.count + 1 : 1;
        session.bucket = bucket;
        if (session.count > 60) {
          socket.close(1013, "制御の頻度上限を超えています。");
          return;
        }
        const row = await nodeRow(this.env, session.nodeId);
        const key = validateControl("PublicJwk", parseJson(row.public_jwk));
        const envelope = await verifyControl(
          message,
          { ...session, direction: "node-to-control" },
          { keys: [key] },
          session.nodeId,
          now,
        );
        session.seen = session.seen.filter((item) => item.expiresAt > now);
        if (
          session.seen.some((item) => item.id === envelope.messageId) ||
          session.seen.length >= 128
        )
          throw new BoundaryError(
            "REPLAY",
            "受理済みの制御IDは再利用できません。",
          );
        session.seen.push({
          id: envelope.messageId,
          expiresAt: Math.floor(Date.parse(envelope.expiresAt) / 1000),
        });
        if (envelope.type === "node.hello")
          await this.hello(session, envelope.payload, row);
        else if (!session.hello)
          throw new BoundaryError(
            "HELLO_REQUIRED",
            "最初に能力を登録してください。",
          );
        else if (envelope.type === "node.heartbeat") {
          const changed = await this.env.TELESTRA_DB.prepare(
            "UPDATE nodes SET last_seen=? WHERE environment=? AND tenant_id=? AND node_id=? AND status='active' AND credential_version=? AND session_epoch=?",
          )
            .bind(
              now,
              session.environment,
              session.tenantId,
              session.nodeId,
              session.credentialVersion,
              session.sessionEpoch,
            )
            .run();
          if (changed.meta.changes !== 1) throw authFailure();
        } else if (envelope.type === "command.ack") {
          const commands = await this.commands();
          const command = commands.find(
            (item) =>
              item.input.commandId === envelope.correlationId &&
              item.credentialVersion === session.credentialVersion,
          );
          if (!command || Date.parse(command.input.expiresAt) <= now * 1000)
            throw new BoundaryError(
              "UNKNOWN_ACK",
              "応答に対応する有効な命令がありません。",
            );
          if (
            command.result &&
            JSON.stringify(command.result) !== JSON.stringify(envelope.payload)
          )
            throw new BoundaryError(
              "ACK_CONFLICT",
              "確定済みの応答は変更できません。",
            );
          command.state = "acknowledged";
          command.result = envelope.payload;
          await this.ctx.storage.put("commands", commands);
        } else
          throw new BoundaryError(
            "DIRECTION_DENIED",
            "Nodeからこの制御は送信できません。",
          );
        session.lastSeen = now;
        await this.ctx.storage.put("session", session);
        await this.schedule(session);
        await this.send(
          socket,
          session,
          this.envelope(session, "control.receipt", {
            messageId: envelope.messageId,
            code: "accepted",
          }),
        );
        if (envelope.type === "node.hello") {
          // 未ACK命令だけを同じID・新しい接続世代で再送する。実行済みの推定はしない。
          for (const command of await this.commands())
            if (
              command.state === "pending" &&
              command.credentialVersion === session.credentialVersion &&
              Date.parse(command.input.expiresAt) > now * 1000
            )
              await this.send(
                socket,
                session,
                this.commandEnvelope(session, command.input),
              );
        }
      } catch {
        // 署名本文やTokenをClose理由・ログへ出さない。
        socket.close(1008, "制御の認証または検証に失敗しました。");
      }
    });
  }

  private async hello(
    session: Session,
    value: ControlMap["WsHello"],
    row: NodeRow,
  ): Promise<void> {
    if (
      session.hello ||
      value.nodeRole !== row.node_role ||
      (value.resume !== undefined &&
        value.resume.lastSessionEpoch >= session.sessionEpoch) ||
      (row.node_role === "tuner" &&
        (value.backend === "encoder" ||
          value.capabilities.some(
            (c) => c === "encode" || c === "mock-encode",
          ))) ||
      (row.node_role === "encoder" &&
        (value.backend !== "encoder" ||
          value.capabilities.some((c) => c === "capture" || c === "epg-read")))
    )
      throw new BoundaryError(
        "CAPABILITY_DENIED",
        "登録したNodeの役割と能力が一致しません。",
      );
    const result = await this.env.TELESTRA_DB.prepare(
      "UPDATE nodes SET capabilities=?,last_seen=? WHERE environment=? AND tenant_id=? AND node_id=? AND status='active' AND credential_version=? AND session_epoch=?",
    )
      .bind(
        JSON.stringify(value),
        nowSeconds(),
        session.environment,
        session.tenantId,
        session.nodeId,
        session.credentialVersion,
        session.sessionEpoch,
      )
      .run();
    if (result.meta.changes !== 1) throw authFailure();
    session.hello = true;
  }

  // 未ACK8件・履歴32件に制限し、遅い受信者へ無制限にsendしない。
  private async dispatch(
    session: Session,
    input: ControlMap["DispatchCommand"],
  ): Promise<Response> {
    if (session.nodeRole !== "tuner")
      throw new BoundaryError(
        "ROLE_DENIED",
        "このNodeへ録画制御は送信できません。",
        403,
      );
    const commands = await this.commands();
    const previous = commands.find(
      (c) => c.input.commandId === input.commandId,
    );
    if (previous) {
      if (
        previous.credentialVersion !== session.credentialVersion ||
        JSON.stringify(previous.input) !== JSON.stringify(input)
      )
        throw new BoundaryError(
          "COMMAND_CONFLICT",
          "同じ命令IDで内容を変更できません。",
          409,
        );
      return json({
        commandId: input.commandId,
        state:
          previous.state === "pending" &&
          Date.parse(previous.input.expiresAt) <= Date.now()
            ? "expired"
            : previous.state,
        result: previous.result ?? null,
      });
    }
    const envelope = this.commandEnvelope(session, input);
    if (
      commands.length >= maxHistory ||
      new TextEncoder().encode(
        JSON.stringify([
          ...commands,
          {
            input,
            credentialVersion: session.credentialVersion,
            state: "pending",
          },
        ]),
      ).byteLength > 65_536 ||
      commands.filter(
        (c) =>
          c.state === "pending" && Date.parse(c.input.expiresAt) > Date.now(),
      ).length >= maxPending
    )
      throw new BoundaryError(
        "BACKPRESSURE",
        "Nodeの応答待ちが上限に達しています。",
        429,
      );
    const socket = this.socket(session);
    if (!socket)
      throw new BoundaryError(
        "NODE_DISCONNECTED",
        "Nodeの接続を待っています。",
        409,
      );
    commands.push({
      input,
      credentialVersion: session.credentialVersion,
      state: "pending",
    });
    await this.ctx.storage.put("commands", commands);
    await this.send(socket, session, envelope);
    return json(
      {
        commandId: input.commandId,
        state: "pending",
        message: "制御を送信しました。実行結果は未確認です。",
      },
      202,
    );
  }

  private envelope(
    session: Session,
    type: "session.ready" | "control.receipt",
    payload: object,
  ): ChannelEnvelope {
    const now = nowSeconds();
    return validateEnvelope(
      {
        protocolVersion: 1,
        messageId: crypto.randomUUID(),
        kind: "event",
        type,
        nodeId: session.nodeId,
        sessionEpoch: session.sessionEpoch,
        issuedAt: new Date(now * 1000).toISOString(),
        expiresAt: new Date(
          Math.min(now + 30, session.expiresAt) * 1000,
        ).toISOString(),
        payload,
      },
      now,
    );
  }
  private commandEnvelope(
    session: Session,
    input: ControlMap["DispatchCommand"],
  ): ChannelEnvelope {
    // JWTの秒精度へ切り下げ、要求された期限を延ばさない。
    const requested = Math.floor(Date.parse(input.expiresAt) / 1000);
    const now = nowSeconds();
    if (!Number.isFinite(requested) || requested <= now || requested > now + 30)
      throw new BoundaryError("INVALID_TIME", "制御の期限を確認してください。");
    const expires = Math.min(requested, session.expiresAt);
    return validateEnvelope(
      {
        protocolVersion: 1,
        messageId: input.commandId,
        kind: "command",
        type: input.type,
        nodeId: session.nodeId,
        sessionEpoch: session.sessionEpoch,
        issuedAt: new Date(nowSeconds() * 1000).toISOString(),
        expiresAt: new Date(expires * 1000).toISOString(),
        payload: input.payload,
      },
      nowSeconds(),
    );
  }
  private async send(
    socket: WebSocket,
    session: Session,
    envelope: ChannelEnvelope,
  ): Promise<void> {
    const token = await signControl(
      {
        iss: this.env.TELESTRA_CONTROL_ISSUER,
        aud: "tv-node-control",
        sub: session.nodeId,
        iat: Date.parse(envelope.issuedAt) / 1000,
        exp: Date.parse(envelope.expiresAt) / 1000,
        jti: envelope.messageId,
        tenantId: session.tenantId,
        environment: this.env.TELESTRA_ENVIRONMENT as "development",
        nodeId: session.nodeId,
        credentialVersion: session.credentialVersion,
        direction: "control-to-node",
        envelope,
      },
      this.env.TELESTRA_CONTROL_PRIVATE_JWK,
    );
    if (token.length > 16_384)
      throw new BoundaryError(
        "TOO_LARGE",
        "制御のサイズ上限を超えています。",
        413,
      );
    socket.send(token);
  }
  private async commands(): Promise<Command[]> {
    const commands = (
      (await this.ctx.storage.get<Command[]>("commands")) ?? []
    ).filter((c) => Date.parse(c.input.expiresAt) + 300_000 > Date.now());
    await this.ctx.storage.put("commands", commands);
    return commands;
  }
  private socket(session: Session): WebSocket | undefined {
    return this.ctx
      .getWebSockets()
      .find(
        (socket) =>
          (socket.deserializeAttachment() as { sessionEpoch?: unknown } | null)
            ?.sessionEpoch === session.sessionEpoch &&
          socket.readyState === WebSocket.OPEN,
      );
  }
  private closeSockets(code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets())
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  }
  private async schedule(session: Session): Promise<void> {
    await this.ctx.storage.setAlarm(
      Math.min(
        session.expiresAt,
        session.lastSeen + (session.hello ? 45 : 10),
      ) * 1000,
    );
  }
  // 失効・期限・無通信をalarmでも照合し、受信がない接続を放置しない。
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const session = await this.live();
      if (session) await this.schedule(session);
    });
  }
  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const session = await this.ctx.storage.get<Session>("session");
      const attachment = socket.deserializeAttachment() as {
        sessionEpoch?: unknown;
      } | null;
      if (session && attachment?.sessionEpoch === session.sessionEpoch) {
        session.connected = false;
        await this.ctx.storage.put("session", session);
        await this.ctx.storage.deleteAlarm();
      }
      if (socket.readyState === WebSocket.OPEN)
        socket.close(code === 1000 ? 1000 : 1008, "接続を終了しました。");
    });
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket, 1008);
  }
}
