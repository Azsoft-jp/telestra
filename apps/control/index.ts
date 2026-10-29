// ローカルWorkerでNode参加と利用者の操作を検証し、永続状態はD1へ保存する。
import { validateControl } from "../../packages/control-contracts/index.ts";
import { BoundaryError } from "../../packages/contracts/error.ts";
import { readJsonBody } from "./body.ts";
import {
  digest,
  parseJson,
  signCredential,
  authFailure,
} from "../../packages/identity/index.ts";
import {
  user,
  role,
  node,
  nodeRow,
  proof,
  nowSeconds,
  audit,
  rateLimit,
  origin,
} from "./auth.ts";
import type { Env, NodeRow } from "./auth.ts";
export { NodeRegistry } from "./registry.ts";

// NodeごとのDO名は設定済み家庭と環境から作り、入力URLから接続先を選ばせない。
function registry(env: Env, nodeId: string): DurableObjectStub {
  return env.TELESTRA_REGISTRY.get(
    env.TELESTRA_REGISTRY.idFromName(
      `${env.TELESTRA_ENVIRONMENT}:${env.TELESTRA_TENANT_ID}:${nodeId}`,
    ),
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function noOrigin(request: Request): void {
  if (request.headers.has("Origin"))
    throw new BoundaryError(
      "FORBIDDEN_ORIGIN",
      "Node専用の接続を使用してください。",
      403,
    );
}
function empty(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  )
    throw new BoundaryError(
      "INVALID_SCHEMA",
      "この操作には空のJSONを指定してください。",
    );
}
// 世代は安全な整数の範囲で進める。上限からの巻き戻しや、自動的なNode ID再利用は行わない。
function assertGenerationAdvance(row: NodeRow, reauthorize: boolean): void {
  if (
    !Number.isSafeInteger(row.credential_version) ||
    row.credential_version < 1 ||
    row.credential_version >= Number.MAX_SAFE_INTEGER ||
    (reauthorize && row.authorization_epoch >= Number.MAX_SAFE_INTEGER)
  )
    throw new BoundaryError(
      "GENERATION_EXHAUSTED",
      "Nodeの世代を更新できません。管理者による確認が必要です。",
      409,
    );
}

async function credential(env: Env, row: NodeRow): Promise<Response> {
  // 現在有効な世代だけに短命資格を発行し、HTTP応答のキャッシュを禁止する。
  if (row.status !== "active") throw authFailure();
  const now = nowSeconds();
  const claims = validateControl("NodeClaims", {
    iss: env.TELESTRA_CONTROL_ISSUER,
    aud: "tv-node-agent",
    sub: row.node_id,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
    tenantId: env.TELESTRA_TENANT_ID,
    environment: env.TELESTRA_ENVIRONMENT,
    nodeId: row.node_id,
    nodeRole: row.node_role,
    credentialVersion: row.credential_version,
  });
  const accessToken = await signCredential(
    claims,
    env.TELESTRA_CONTROL_PRIVATE_JWK,
  );
  return json(
    validateControl("CredentialResponse", {
      nodeId: row.node_id,
      nodeRole: row.node_role,
      credentialVersion: row.credential_version,
      expiresAt: claims.exp,
      accessToken,
    }),
  );
}

async function route(request: Request, env: Env): Promise<Response> {
  // この構成はローカル開発専用とし、本番用の設定や初期資格を受け付けない。
  if (
    env.TELESTRA_ENVIRONMENT !== "development" ||
    !/^[A-Za-z0-9_.:-]{3,128}$/.test(env.TELESTRA_TENANT_ID)
  )
    throw new BoundaryError(
      "NOT_DEPLOYABLE",
      "ローカル開発用の構成を確認してください。",
      503,
    );
  const url = new URL(request.url);
  if (url.search)
    throw new BoundaryError(
      "INVALID_QUERY",
      "この操作にはクエリを指定できません。",
    );
  if (request.method === "OPTIONS") {
    const allowedOrigin = origin(request, env);
    const method = request.headers.get("Access-Control-Request-Method");
    const headers = (
      request.headers.get("Access-Control-Request-Headers") ?? ""
    )
      .toLowerCase()
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      !["GET", "POST"].includes(method ?? "") ||
      headers.some((h) => !["authorization", "content-type"].includes(h))
    )
      throw new BoundaryError(
        "FORBIDDEN_CORS",
        "この接続方法は許可されていません。",
        403,
      );
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        Vary: "Origin",
        "Cache-Control": "no-store",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/health")
    return json({
      state: "local-only",
      message: "ローカルの制御APIが起動しています。",
    });
  if (request.method === "GET" && url.pathname === "/agent") {
    if (url.protocol !== "https:")
      throw new BoundaryError("TLS_REQUIRED", "WSSで接続してください。", 400);
    const identity = await node(request, env);
    return registry(env, identity.row.node_id).fetch(
      new Request("https://registry.example.invalid/connect", request),
    );
  }
  if (request.method === "POST" && url.pathname === "/nodes/join") {
    // 参加権利をD1の条件付き更新と同じbatchで消費し、再利用による再発行を防ぐ。
    noOrigin(request);
    const input = validateControl("JoinNode", await readJsonBody(request));
    await rateLimit(env, `join:${input.nodeId}`, 12);
    const row = await nodeRow(env, input.nodeId);
    if (row.status === "revoked") throw authFailure();
    await proof(env, row, input.proof, "join", input.code);
    assertGenerationAdvance(row, true);
    const hash = await digest(input.code);
    const results = await env.TELESTRA_DB.batch([
      env.TELESTRA_DB.prepare(
        "UPDATE nodes SET status='active',credential_version=credential_version+1,authorization_epoch=authorization_epoch+1 WHERE environment=? AND tenant_id=? AND node_id=? AND status!='revoked' AND credential_version<9007199254740991 AND authorization_epoch<9007199254740991 AND EXISTS(SELECT 1 FROM node_joins j WHERE j.environment=nodes.environment AND j.tenant_id=nodes.tenant_id AND j.node_id=nodes.node_id AND j.code_hash=? AND j.expires_at>?)",
      ).bind(
        env.TELESTRA_ENVIRONMENT,
        env.TELESTRA_TENANT_ID,
        input.nodeId,
        hash,
        nowSeconds(),
      ),
      env.TELESTRA_DB.prepare(
        "DELETE FROM node_joins WHERE environment=? AND tenant_id=? AND node_id=? AND code_hash=?",
      ).bind(
        env.TELESTRA_ENVIRONMENT,
        env.TELESTRA_TENANT_ID,
        input.nodeId,
        hash,
      ),
    ]);
    if (results[0]?.meta.changes !== 1) throw authFailure();
    await audit(env, "node.join", input.nodeId, input.nodeId);
    return credential(env, await nodeRow(env, input.nodeId));
  }
  if (request.method === "POST" && url.pathname === "/nodes/rotate") {
    // 旧資格と端末の署名の両方を要求し、世代更新後は旧Tokenを無効にする。
    const identity = await node(request, env);
    const input = validateControl("RotateNode", await readJsonBody(request));
    await rateLimit(env, `rotate:${identity.row.node_id}`, 12);
    await proof(env, identity.row, input.proof, "rotate", identity.claims.jti);
    assertGenerationAdvance(identity.row, false);
    // 通常rotateは認可を変更しない。録画許可の世代へ資格の寿命を流用しない。
    const changed = await env.TELESTRA_DB.prepare(
      "UPDATE nodes SET credential_version=credential_version+1 WHERE environment=? AND tenant_id=? AND node_id=? AND status='active' AND credential_version=? AND credential_version<9007199254740991",
    )
      .bind(
        env.TELESTRA_ENVIRONMENT,
        env.TELESTRA_TENANT_ID,
        identity.row.node_id,
        identity.claims.credentialVersion,
      )
      .run();
    if (changed.meta.changes !== 1) throw authFailure();
    await registry(env, identity.row.node_id).fetch(
      "https://registry.example.invalid/invalidate",
      { method: "POST" },
    );
    await audit(env, "node.rotate", identity.row.node_id, identity.row.node_id);
    return credential(env, await nodeRow(env, identity.row.node_id));
  }
  if (request.method === "GET" && url.pathname === "/agent/identity") {
    const identity = await node(request, env);
    return json({
      nodeId: identity.row.node_id,
      nodeRole: identity.row.node_role,
      credentialVersion: identity.row.credential_version,
      sessionEpoch: identity.row.session_epoch,
    });
  }

  const actor = await user(request, env);
  // 以下のBrowser用操作には、Originと認証済み主体から作った権限だけを渡す。
  await rateLimit(env, `user:${actor.subject}`);
  const connection =
    /^\/nodes\/([A-Za-z0-9_.:-]{3,128})\/(connection|commands)$/.exec(
      url.pathname,
    );
  if (
    connection?.[1] &&
    ((request.method === "GET" && connection[2] === "connection") ||
      (request.method === "POST" && connection[2] === "commands"))
  ) {
    role(actor, ["operator", "admin"]);
    await nodeRow(env, connection[1]);
    // 外側で実読取サイズを制限し、DOにも認証情報と構造化したJSONだけを渡す。
    const input =
      request.method === "POST"
        ? JSON.stringify(await readJsonBody(request))
        : undefined;
    const headers = new Headers(request.headers);
    if (input !== undefined) {
      // JSONを作り直した本文には、受信時の長さ・圧縮・転送方式を引き継がない。
      headers.delete("Content-Length");
      headers.delete("Content-Encoding");
      headers.delete("Transfer-Encoding");
    }
    return registry(env, connection[1]).fetch(
      new Request(
        `https://registry.example.invalid/${connection[2] === "connection" ? "status" : "commands"}`,
        {
          method: request.method,
          headers,
          ...(input !== undefined ? { body: input } : {}),
        },
      ),
    );
  }
  if (request.method === "GET" && url.pathname === "/session")
    return json({
      subject: actor.subject,
      role: actor.role,
      tenantId: env.TELESTRA_TENANT_ID,
      environment: env.TELESTRA_ENVIRONMENT,
      expiresAt: actor.expiresAt,
    });
  if (request.method === "POST" && url.pathname === "/sessions/revoke") {
    empty(await readJsonBody(request));
    await env.TELESTRA_DB.prepare(
      "INSERT INTO revoked_tokens(environment,tenant_id,jti,expires_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    )
      .bind(
        env.TELESTRA_ENVIRONMENT,
        env.TELESTRA_TENANT_ID,
        actor.jti,
        actor.expiresAt,
      )
      .run();
    return json({
      state: "revoked",
      message: "この認証情報を失効しました。再ログインしてください。",
    });
  }
  if (request.method === "POST" && url.pathname === "/nodes") {
    role(actor, ["operator", "admin"]);
    const input = validateControl("RegisterNode", await readJsonBody(request));
    const result = await env.TELESTRA_DB.prepare(
      "INSERT INTO nodes(environment,tenant_id,node_id,node_role,public_jwk,status) VALUES(?,?,?,?,?,'pending') ON CONFLICT DO NOTHING",
    )
      .bind(
        env.TELESTRA_ENVIRONMENT,
        env.TELESTRA_TENANT_ID,
        input.nodeId,
        input.nodeRole,
        JSON.stringify(input.publicKey),
      )
      .run();
    const row = await nodeRow(env, input.nodeId);
    const registered = validateControl("PublicJwk", parseJson(row.public_jwk));
    if (
      row.node_role !== input.nodeRole ||
      registered.x !== input.publicKey.x ||
      registered.kid !== input.publicKey.kid
    )
      throw new BoundaryError(
        "IDENTITY_CONFLICT",
        "登録済みのNode識別情報は上書きできません。",
        409,
      );
    if (result.meta.changes === 1)
      await audit(env, "node.register", actor.subject, input.nodeId);
    return json(
      { nodeId: row.node_id, nodeRole: row.node_role, state: row.status },
      result.meta.changes === 1 ? 201 : 200,
    );
  }
  if (request.method === "POST" && url.pathname === "/nodes/challenges") {
    role(actor, ["operator", "admin"]);
    const input = validateControl("JoinChallenge", await readJsonBody(request));
    const row = await nodeRow(env, input.nodeId);
    if (row.status === "revoked")
      throw new BoundaryError(
        "NODE_REVOKED",
        "失効したNodeには参加権利を発行できません。",
        409,
      );
    const random = crypto.getRandomValues(new Uint8Array(32));
    const code = btoa(String.fromCharCode(...random))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    await env.TELESTRA_DB.prepare(
      "INSERT INTO node_joins(environment,tenant_id,node_id,code_hash,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(environment,tenant_id,node_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at",
    )
      .bind(
        env.TELESTRA_ENVIRONMENT,
        env.TELESTRA_TENANT_ID,
        input.nodeId,
        await digest(code),
        nowSeconds() + 120,
      )
      .run();
    await audit(env, "node.challenge", actor.subject, input.nodeId);
    return json({ nodeId: input.nodeId, code, expiresAt: nowSeconds() + 120 });
  }
  const revocation = /^\/nodes\/([A-Za-z0-9_.:-]{3,128})\/revoke$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && revocation?.[1]) {
    role(actor, ["operator", "admin"]);
    empty(await readJsonBody(request));
    const nodeId = revocation[1];
    await nodeRow(env, nodeId);
    // 失効状態と両世代を同じUPDATEで確定する。上限でも失効を拒否せず、値を巻き戻さない。
    const changed = await env.TELESTRA_DB.prepare(
      "UPDATE nodes SET status='revoked',credential_version=MIN(credential_version+1,9007199254740991),authorization_epoch=MIN(authorization_epoch+1,9007199254740991) WHERE environment=? AND tenant_id=? AND node_id=? AND status!='revoked'",
    )
      .bind(env.TELESTRA_ENVIRONMENT, env.TELESTRA_TENANT_ID, nodeId)
      .run();
    await env.TELESTRA_DB.prepare(
      "DELETE FROM node_joins WHERE environment=? AND tenant_id=? AND node_id=?",
    )
      .bind(env.TELESTRA_ENVIRONMENT, env.TELESTRA_TENANT_ID, nodeId)
      .run();
    if (changed.meta.changes === 1)
      await audit(env, "node.revoke", actor.subject, nodeId);
    await registry(env, nodeId).fetch(
      "https://registry.example.invalid/invalidate",
      {
        method: "POST",
      },
    );
    return json({
      nodeId,
      state: "revoked",
      message: "Nodeの資格を失効しました。",
    });
  }
  if (request.method === "POST" && url.pathname === "/reservations") {
    role(actor, ["recorder", "admin"]);
    const input = validateControl(
      "ReservationInput",
      await readJsonBody(request),
    );
    const starts = Date.parse(input.startsAt),
      ends = Date.parse(input.endsAt);
    if (
      !Number.isFinite(starts) ||
      !Number.isFinite(ends) ||
      starts < nowSeconds() * 1000 ||
      ends <= starts ||
      ends - starts > 86_400_000
    )
      throw new BoundaryError("INVALID_TIME", "予約日時を確認してください。");
    const payload = JSON.stringify({
      reservationId: input.reservationId,
      serviceKey: input.serviceKey,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });
    const result = await env.TELESTRA_DB.prepare(
      "INSERT INTO reservations(environment,tenant_id,reservation_id,owner_id,payload) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
      .bind(
        env.TELESTRA_ENVIRONMENT,
        env.TELESTRA_TENANT_ID,
        input.reservationId,
        actor.subject,
        payload,
      )
      .run();
    const previous = await env.TELESTRA_DB.prepare(
      "SELECT owner_id,payload FROM reservations WHERE environment=? AND tenant_id=? AND reservation_id=?",
    )
      .bind(
        env.TELESTRA_ENVIRONMENT,
        env.TELESTRA_TENANT_ID,
        input.reservationId,
      )
      .first<{ owner_id: string; payload: string }>();
    if (!previous || previous.owner_id !== actor.subject)
      throw new BoundaryError(
        "FORBIDDEN",
        "この録画予約を利用できません。",
        403,
      );
    if (previous.payload !== payload)
      throw new BoundaryError(
        "RESERVATION_CONFLICT",
        "同じ予約IDで内容を変更できません。",
        409,
      );
    return json(
      {
        reservationId: input.reservationId,
        state: "scheduled",
        message:
          "録画予約を受け付けました。実行ノードへの割り当ては未実装です。",
      },
      result.meta.changes === 1 ? 202 : 200,
    );
  }
  const reservation = /^\/reservations\/([A-Za-z0-9_.:-]{3,128})$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && reservation?.[1]) {
    const record = await env.TELESTRA_DB.prepare(
      "SELECT owner_id,payload,state,revision FROM reservations WHERE environment=? AND tenant_id=? AND reservation_id=?",
    )
      .bind(env.TELESTRA_ENVIRONMENT, env.TELESTRA_TENANT_ID, reservation[1])
      .first<{
        owner_id: string;
        payload: string;
        state: string;
        revision: number;
      }>();
    if (!record || record.owner_id !== actor.subject)
      throw new BoundaryError("NOT_FOUND", "録画予約を利用できません。", 404);
    return json({
      ...validateControl("ReservationInput", parseJson(record.payload)),
      state: record.state,
      revision: record.revision,
    });
  }
  const recording = /^\/recordings\/([A-Za-z0-9_.:-]{3,128})$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && recording?.[1]) {
    const record = await env.TELESTRA_DB.prepare(
      "SELECT owner_id,payload FROM recordings WHERE environment=? AND tenant_id=? AND recording_id=?",
    )
      .bind(env.TELESTRA_ENVIRONMENT, env.TELESTRA_TENANT_ID, recording[1])
      .first<{ owner_id: string; payload: string }>();
    if (!record || record.owner_id !== actor.subject)
      throw new BoundaryError("NOT_FOUND", "この録画を利用できません。", 404);
    const value = validateControl("RecordingState", parseJson(record.payload));
    if (value.recordingId !== recording[1])
      throw new BoundaryError(
        "INVALID_LEDGER",
        "録画台帳の整合性を確認できません。",
        503,
      );
    return json(value);
  }
  throw new BoundaryError("NOT_FOUND", "この操作は利用できません。", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
      // Upgrade応答のWebSocketを失わないよう、そのまま返す。
      if (response.status === 101) return response;
    } catch (error) {
      response =
        error instanceof BoundaryError
          ? json({ code: error.code, message: error.message }, error.status)
          : json(
              {
                code: "CONTROL_UNAVAILABLE",
                message:
                  "制御APIを利用できません。時間をおいて再試行してください。",
              },
              503,
            );
    }
    const headers = new Headers(response.headers);
    headers.set("X-Request-Id", crypto.randomUUID());
    try {
      headers.set("Access-Control-Allow-Origin", origin(request, env));
      headers.set("Vary", "Origin");
    } catch {
      /* 許可されていないOriginへCORSの権利を返さない。 */
    }
    return new Response(response.body, { status: response.status, headers });
  },
};
