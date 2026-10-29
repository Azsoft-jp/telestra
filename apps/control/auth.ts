// 利用者とNodeの認証を分け、D1の所属・資格世代・失効状態で認可する。
import {
  bearer,
  verifyIdentity,
  publicKeys,
  authFailure,
  parseJson,
  digest,
} from "../../packages/identity/index.ts";
import type { ControlMap } from "../../packages/control-contracts/index.ts";
import { validateControl } from "../../packages/control-contracts/index.ts";
import { BoundaryError } from "../../packages/contracts/error.ts";

export interface Env {
  TELESTRA_DB: D1Database;
  TELESTRA_REGISTRY: DurableObjectNamespace;
  TELESTRA_ENVIRONMENT: string;
  TELESTRA_TENANT_ID: string;
  TELESTRA_ALLOWED_ORIGINS: string;
  TELESTRA_OIDC_ISSUER: string;
  TELESTRA_OIDC_AUDIENCE: string;
  TELESTRA_OIDC_JWKS: string;
  TELESTRA_CONTROL_ISSUER: string;
  TELESTRA_CONTROL_PUBLIC_JWKS: string;
  TELESTRA_CONTROL_PRIVATE_JWK: string;
  TELESTRA_CAPTURE_POLICY_PRIVATE_JWK?: string;
  TELESTRA_CAPTURE_POLICY_MAX_LIFETIME_SECONDS?: string;
}
export interface NodeRow {
  node_id: string;
  node_role: "tuner" | "encoder";
  public_jwk: string;
  credential_version: number;
  authorization_epoch: number;
  session_epoch: number;
  status: "pending" | "active" | "revoked";
}
export type UserRole = "viewer" | "recorder" | "operator" | "admin";
export interface User {
  subject: string;
  role: UserRole;
  jti: string;
  expiresAt: number;
}
// TokenとD1の期限を同じ秒単位で比較する。
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
// Originは完全一致で照合し、未指定・null・似た別ドメインを拒否する。
export function origin(request: Request, env: Env): string {
  const allowed = parseJson(env.TELESTRA_ALLOWED_ORIGINS) as unknown;
  const value = request.headers.get("Origin");
  if (
    !Array.isArray(allowed) ||
    value === null ||
    value === "null" ||
    !allowed.includes(value) ||
    new URL(value).origin !== value
  )
    throw new BoundaryError(
      "FORBIDDEN_ORIGIN",
      "この接続元からは操作できません。",
      403,
    );
  return value;
}
export async function user(request: Request, env: Env): Promise<User> {
  // Tokenは主体の確認に使い、家庭・Role・失効の判断はD1の現在値から行う。
  origin(request, env);
  const claims = await verifyIdentity(
    "UserClaims",
    bearer(request.headers.get("Authorization")),
    {
      issuer: env.TELESTRA_OIDC_ISSUER,
      audience: env.TELESTRA_OIDC_AUDIENCE,
      typ: "at+jwt",
      jwks: publicKeys(env.TELESTRA_OIDC_JWKS),
      now: nowSeconds(),
      maxLifetime: 900,
    },
  );
  const membership = await env.TELESTRA_DB.prepare(
    "SELECT role,status FROM memberships WHERE environment=? AND tenant_id=? AND subject=?",
  )
    .bind(env.TELESTRA_ENVIRONMENT, env.TELESTRA_TENANT_ID, claims.sub)
    .first<{ role: UserRole; status: string }>();
  const revoked = await env.TELESTRA_DB.prepare(
    "SELECT jti FROM revoked_tokens WHERE environment=? AND tenant_id=? AND jti=? AND expires_at>?",
  )
    .bind(
      env.TELESTRA_ENVIRONMENT,
      env.TELESTRA_TENANT_ID,
      claims.jti,
      nowSeconds(),
    )
    .first();
  if (!membership || membership.status !== "active" || revoked)
    throw authFailure();
  return {
    subject: claims.sub,
    role: membership.role,
    jti: claims.jti,
    expiresAt: claims.exp,
  };
}
// D1から取得した利用者Roleを、操作ごとの許可リストと照合する。
export function role(actor: User, allowed: readonly UserRole[]): void {
  if (!allowed.includes(actor.role))
    throw new BoundaryError(
      "FORBIDDEN",
      "この操作を行う権限がありません。",
      403,
    );
}
// 家庭と環境を条件に含め、同じNode IDでも別の台帳を参照させない。
export async function nodeRow(env: Env, nodeId: string): Promise<NodeRow> {
  const value = await env.TELESTRA_DB.prepare(
    "SELECT node_id,node_role,public_jwk,status,credential_version,authorization_epoch,session_epoch FROM nodes WHERE environment=? AND tenant_id=? AND node_id=?",
  )
    .bind(env.TELESTRA_ENVIRONMENT, env.TELESTRA_TENANT_ID, nodeId)
    .first<NodeRow>();
  if (!value) throw authFailure();
  // 未移行・欠損・不正な認可世代を1へ補完せず、保存状態の修復が必要として拒否する。
  if (
    !Number.isSafeInteger(value.authorization_epoch) ||
    value.authorization_epoch < 1
  )
    throw new BoundaryError(
      "INVALID_AUTHORIZATION_STATE",
      "Nodeの認可状態を確認できません。管理者による確認が必要です。",
      503,
    );
  return value;
}
export async function node(
  request: Request,
  env: Env,
): Promise<{ claims: ControlMap["NodeClaims"]; row: NodeRow }> {
  // Browser用Tokenを受け付けず、署名済みのNode IDとD1の資格世代を照合する。
  if (request.headers.has("Origin"))
    throw new BoundaryError(
      "FORBIDDEN_ORIGIN",
      "Node専用の接続を使用してください。",
      403,
    );
  const claims = await verifyIdentity(
    "NodeClaims",
    bearer(request.headers.get("Authorization")),
    {
      issuer: env.TELESTRA_CONTROL_ISSUER,
      audience: "tv-node-agent",
      typ: "tv-node+jwt",
      jwks: publicKeys(env.TELESTRA_CONTROL_PUBLIC_JWKS),
      now: nowSeconds(),
      maxLifetime: 300,
    },
  );
  if (
    claims.environment !== env.TELESTRA_ENVIRONMENT ||
    claims.tenantId !== env.TELESTRA_TENANT_ID ||
    claims.sub !== claims.nodeId
  )
    throw authFailure();
  const row = await nodeRow(env, claims.nodeId);
  if (
    row.status !== "active" ||
    row.credential_version !== claims.credentialVersion ||
    row.node_role !== claims.nodeRole
  )
    throw authFailure();
  return { claims, row };
}
export async function proof(
  env: Env,
  row: NodeRow,
  token: string,
  purpose: "join" | "rotate" | "connect" | "capture-policy",
  challenge: string,
): Promise<ControlMap["DeviceProof"]> {
  // 登録済みの端末鍵で参加・更新の目的とchallengeを拘束し、別操作への転用を防ぐ。
  const key = validateControl("PublicJwk", parseJson(row.public_jwk));
  const claims = await verifyIdentity("DeviceProof", token, {
    issuer: row.node_id,
    audience: "tv-node-device-proof",
    typ: "tv-device-proof+jwt",
    jwks: { keys: [key] },
    now: nowSeconds(),
    maxLifetime: 60,
  });
  if (
    claims.sub !== row.node_id ||
    claims.nodeId !== row.node_id ||
    claims.tenantId !== env.TELESTRA_TENANT_ID ||
    claims.environment !== env.TELESTRA_ENVIRONMENT ||
    claims.purpose !== purpose ||
    claims.challengeHash !== (await digest(challenge))
  )
    throw authFailure();
  return claims;
}
export async function rateLimit(
  env: Env,
  scope: string,
  maximum = 60,
): Promise<void> {
  // 上限内の場合だけ件数を更新し、同じ時間窓の同時要求でも上限を越えさせない。
  const bucket = Math.floor(nowSeconds() / 60);
  const result = await env.TELESTRA_DB.prepare(
    "INSERT INTO rate_limits(scope,bucket,count) VALUES(?,?,1) ON CONFLICT(scope,bucket) DO UPDATE SET count=count+1 WHERE count<?",
  )
    .bind(await digest(scope), bucket, maximum)
    .run();
  if (result.meta.changes !== 1)
    throw new BoundaryError(
      "RATE_LIMIT",
      "操作が集中しています。時間をおいて再試行してください。",
      429,
    );
  await env.TELESTRA_DB.prepare("DELETE FROM rate_limits WHERE bucket<?")
    .bind(bucket - 2)
    .run();
}
export async function audit(
  env: Env,
  action: string,
  subject: string,
  nodeId: string | null,
): Promise<void> {
  // 監査には操作、主体のhash、Node ID、時刻を残し、Token・参加コード・鍵は保存しない。
  await env.TELESTRA_DB.prepare(
    "INSERT INTO identity_audit(event_id,action,actor_hash,node_id,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      action,
      await digest(subject),
      nodeId,
      nowSeconds(),
    )
    .run();
}
