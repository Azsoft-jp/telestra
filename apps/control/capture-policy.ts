// D1の現在のNode・予約・最新割当へ拘束したpolicyだけを署名する。DOメモリを認可の原本にしない。
import { validateControl } from "../../packages/control-contracts/index.ts";
import type { ControlMap } from "../../packages/control-contracts/index.ts";
import { strictJson } from "../../packages/capture-permit/json.ts";
import { asciiCaptureFields } from "../../packages/capture-permit/signature.ts";
import { signCapturePolicy } from "../../packages/capture-permit/sign-policy.ts";
import { BoundaryError } from "../../packages/contracts/error.ts";
type Claims = ControlMap["CapturePolicyV2"];
interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}
// 現在のD1 bindingが持つ必要な操作だけを受け、別providerの同等性を表すAdapterにはしない。
export interface PolicySourceEnv {
  TELESTRA_DB: {
    prepare(sql: string): Statement;
    withSession(mode: "first-primary"): { prepare(sql: string): Statement };
  };
  TELESTRA_ENVIRONMENT: string;
  TELESTRA_TENANT_ID: string;
  TELESTRA_CONTROL_ISSUER: string;
  TELESTRA_CAPTURE_POLICY_PRIVATE_JWK?: string;
  TELESTRA_CAPTURE_POLICY_MAX_LIFETIME_SECONDS?: string;
}
interface Row {
  node_id: string;
  authorization_epoch: number;
  reservation_id: string;
  reservation_revision: number;
  attempt_id: string;
  assignment_epoch: number;
  recording_id: string;
  policy_id: string;
  permit_id: string;
  revoked: number;
  claims: string;
  reservation_payload: string;
}
const unavailable = () =>
  new BoundaryError(
    "POLICY_UNAVAILABLE",
    "録画policyを発行できません。構成と割当を確認してください。",
    503,
  );
const conflict = () =>
  new BoundaryError(
    "POLICY_CONFLICT",
    "録画policyの世代または予約が更新されています。状態を確認してください。",
    409,
  );

function maxLifetime(env: PolicySourceEnv): number {
  const raw = env.TELESTRA_CAPTURE_POLICY_MAX_LIFETIME_SECONDS;
  if (
    !env.TELESTRA_CAPTURE_POLICY_PRIVATE_JWK ||
    typeof raw !== "string" ||
    !/^\d{1,16}$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < 1
  )
    throw unavailable();
  return Number(raw);
}
function parseClaims(env: PolicySourceEnv, raw: string): Claims {
  const claims = validateControl(
    "CapturePolicyV2",
    strictJson(new TextEncoder().encode(raw), 4096),
  );
  if (
    !asciiCaptureFields(claims) ||
    claims.iss !== env.TELESTRA_CONTROL_ISSUER ||
    claims.tenantId !== env.TELESTRA_TENANT_ID ||
    claims.environment !== env.TELESTRA_ENVIRONMENT ||
    claims.sub !== claims.nodeId ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > maxLifetime(env) ||
    claims.captureLatest <= claims.captureEarliest ||
    claims.maxPermitLifetime < 1 ||
    claims.maxOfflineSeconds > claims.maxPermitLifetime
  )
    throw unavailable();
  return claims;
}
function validateRow(env: PolicySourceEnv, row: Row): Claims {
  const claims = parseClaims(env, row.claims);
  if (
    claims.nodeId !== row.node_id ||
    claims.authorizationEpoch !== row.authorization_epoch ||
    claims.reservationId !== row.reservation_id ||
    claims.reservationRevision !== row.reservation_revision ||
    claims.attemptId !== row.attempt_id ||
    claims.assignmentEpoch !== row.assignment_epoch ||
    claims.recordingId !== row.recording_id ||
    claims.jti !== row.policy_id ||
    claims.permitId !== row.permit_id ||
    Number(claims.revoked) !== row.revoked
  )
    throw unavailable();
  const reservation = validateControl(
    "ReservationInput",
    strictJson(new TextEncoder().encode(row.reservation_payload), 8192),
  );
  const starts = Date.parse(reservation.startsAt),
    ends = Date.parse(reservation.endsAt);
  if (
    !Number.isFinite(starts) ||
    !Number.isFinite(ends) ||
    reservation.reservationId !== claims.reservationId ||
    reservation.serviceKey !== claims.serviceKey ||
    claims.captureEarliest < Math.ceil(starts / 1000) ||
    claims.captureLatest > Math.floor(ends / 1000)
  )
    throw unavailable();
  return claims;
}

// 各照合で新しいfirst-primary sessionを作る。署名待ち中に変わった失効・割当も再度読む。
async function eligible(
  env: PolicySourceEnv,
  nodeId: string,
  recordingId: string,
  credentialVersion: number | null,
): Promise<Row | null> {
  return env.TELESTRA_DB.withSession("first-primary")
    .prepare(
      "SELECT p.*,r.payload AS reservation_payload FROM capture_policies p JOIN nodes n ON n.environment=p.environment AND n.tenant_id=p.tenant_id AND n.node_id=p.node_id JOIN reservations r ON r.environment=p.environment AND r.tenant_id=p.tenant_id AND r.reservation_id=p.reservation_id JOIN recordings q ON q.environment=p.environment AND q.tenant_id=p.tenant_id AND q.recording_id=p.recording_id AND q.owner_id=r.owner_id WHERE p.environment=? AND p.tenant_id=? AND p.recording_id=? AND p.node_id=? AND n.node_role='tuner' AND n.status='active' AND n.authorization_epoch=p.authorization_epoch AND (? IS NULL OR n.credential_version=?) AND r.revision=p.reservation_revision AND (r.state='scheduled' OR (r.state='cancelled' AND p.revoked=1)) AND p.assignment_epoch=(SELECT MAX(c.assignment_epoch) FROM capture_policies c WHERE c.environment=p.environment AND c.tenant_id=p.tenant_id AND c.recording_id=p.recording_id)",
    )
    .bind(
      env.TELESTRA_ENVIRONMENT,
      env.TELESTRA_TENANT_ID,
      recordingId,
      nodeId,
      credentialVersion,
      credentialVersion,
    )
    .first<Row>();
}

// 内部Scheduler向けのCAS保存。公開HTTPの書込APIではなく、BackendとStorageの構成確認は呼出元で行う。
export async function saveCapturePolicy(
  env: PolicySourceEnv,
  value: Claims,
  now: number,
): Promise<boolean> {
  const raw = JSON.stringify(value),
    claims = parseClaims(env, raw);
  if (!Number.isSafeInteger(now) || claims.iat > now || claims.exp <= now)
    throw conflict();
  const previous = await env.TELESTRA_DB.withSession("first-primary")
    .prepare(
      "SELECT claims FROM capture_policies WHERE environment=? AND tenant_id=? AND recording_id=? ORDER BY assignment_epoch DESC LIMIT 1",
    )
    .bind(env.TELESTRA_ENVIRONMENT, env.TELESTRA_TENANT_ID, claims.recordingId)
    .first<{ claims: string }>();
  const old = previous ? parseClaims(env, previous.claims) : null;
  if (old && old.assignmentEpoch === claims.assignmentEpoch) {
    const current = await eligible(
      env,
      claims.nodeId,
      claims.recordingId,
      null,
    );
    if (current?.claims === raw) {
      try {
        validateRow(env, current);
      } catch {
        throw unavailable();
      }
      return false;
    }
    throw conflict();
  }
  if (
    claims.assignmentEpoch !== (old?.assignmentEpoch ?? 0) + 1 ||
    (old &&
      (claims.reservationRevision < old.reservationRevision ||
        (claims.nodeId === old.nodeId &&
          claims.authorizationEpoch < old.authorizationEpoch)))
  )
    throw conflict();
  if (
    old &&
    claims.attemptId === old.attemptId &&
    [
      "nodeId",
      "reservationId",
      "backendId",
      "serviceKey",
      "captureScope",
      "storageScopeId",
    ].some((name) => claims[name as keyof Claims] !== old[name as keyof Claims])
  )
    throw conflict();
  const reservation = await env.TELESTRA_DB.withSession("first-primary")
    .prepare(
      "SELECT r.payload FROM reservations r JOIN recordings q ON q.environment=r.environment AND q.tenant_id=r.tenant_id AND q.owner_id=r.owner_id WHERE r.environment=? AND r.tenant_id=? AND r.reservation_id=? AND r.revision=? AND q.recording_id=?",
    )
    .bind(
      claims.environment,
      claims.tenantId,
      claims.reservationId,
      claims.reservationRevision,
      claims.recordingId,
    )
    .first<{ payload: string }>();
  if (!reservation) throw conflict();
  validateRow(env, {
    node_id: claims.nodeId,
    authorization_epoch: claims.authorizationEpoch,
    reservation_id: claims.reservationId,
    reservation_revision: claims.reservationRevision,
    attempt_id: claims.attemptId,
    assignment_epoch: claims.assignmentEpoch,
    recording_id: claims.recordingId,
    policy_id: claims.jti,
    permit_id: claims.permitId,
    revoked: Number(claims.revoked),
    claims: raw,
    reservation_payload: reservation.payload,
  });
  const result = await env.TELESTRA_DB.prepare(
    "INSERT INTO capture_policies(environment,tenant_id,recording_id,assignment_epoch,node_id,authorization_epoch,reservation_id,reservation_revision,attempt_id,policy_id,permit_id,revoked,claims) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(assignment_epoch) FROM capture_policies WHERE environment=? AND tenant_id=? AND recording_id=?),0)=? AND EXISTS(SELECT 1 FROM nodes WHERE environment=? AND tenant_id=? AND node_id=? AND node_role='tuner' AND status='active' AND authorization_epoch=?) AND EXISTS(SELECT 1 FROM reservations r JOIN recordings q ON q.environment=r.environment AND q.tenant_id=r.tenant_id AND q.owner_id=r.owner_id WHERE r.environment=? AND r.tenant_id=? AND r.reservation_id=? AND r.revision=? AND r.payload=? AND q.recording_id=? AND (r.state='scheduled' OR (r.state='cancelled' AND ?=1)))",
  )
    .bind(
      claims.environment,
      claims.tenantId,
      claims.recordingId,
      claims.assignmentEpoch,
      claims.nodeId,
      claims.authorizationEpoch,
      claims.reservationId,
      claims.reservationRevision,
      claims.attemptId,
      claims.jti,
      claims.permitId,
      Number(claims.revoked),
      raw,
      claims.environment,
      claims.tenantId,
      claims.recordingId,
      old?.assignmentEpoch ?? 0,
      claims.environment,
      claims.tenantId,
      claims.nodeId,
      claims.authorizationEpoch,
      claims.environment,
      claims.tenantId,
      claims.reservationId,
      claims.reservationRevision,
      reservation.payload,
      claims.recordingId,
      Number(claims.revoked),
    )
    .run();
  if (result.meta.changes !== 1) throw conflict();
  // 署名を返す処理は別の現在値照合を必須とする。保存だけでは媒体実行を許可しない。
  return true;
}

// 有効なNode資格と端末証明の確認後に呼ぶ。署名処理の前後で現在値を照合し、旧割当を配信しない。
export async function issueCapturePolicy(
  env: PolicySourceEnv,
  nodeId: string,
  credentialVersion: number,
  recordingId: string,
  clock: () => number,
): Promise<string> {
  maxLifetime(env);
  const row = await eligible(env, nodeId, recordingId, credentialVersion);
  if (!row)
    throw new BoundaryError(
      "NOT_FOUND",
      "この録画policyを利用できません。",
      404,
    );
  let claims: Claims;
  try {
    claims = validateRow(env, row);
  } catch {
    throw unavailable();
  }
  if (claims.iat > clock() || claims.exp <= clock()) throw conflict();
  let token: string;
  try {
    token = await signCapturePolicy(
      claims,
      env.TELESTRA_CAPTURE_POLICY_PRIVATE_JWK!,
    );
  } catch {
    throw unavailable();
  }
  const current = await eligible(env, nodeId, recordingId, credentialVersion);
  if (
    !current ||
    current.claims !== row.claims ||
    current.reservation_payload !== row.reservation_payload ||
    claims.exp <= clock()
  )
    throw conflict();
  try {
    validateRow(env, current);
  } catch {
    throw unavailable();
  }
  return token;
}
