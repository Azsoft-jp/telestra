// 未採用のPermit候補の関係だけを評価する。署名検証器・録画許可・実行APIではない。
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import example from "../../docs/proposals/capture-permit-v2/example.json" with { type: "json" };

export type Candidate = typeof example.claims;
export type CandidateScope = typeof example.scope;
export interface CandidatePolicy {
  issuer: string;
  tenantId: string;
  environment: string;
  nodeId: string;
  role: "tuner" | "encoder";
  authorizationEpoch: number;
  assignmentEpoch: number;
  reservationId: string;
  reservationRevision: number;
  recordingId: string;
  attemptId: string;
  backendId: string;
  serviceKey: string;
  captureScope: string;
  allowMultiplex: boolean;
  anchorKnown: boolean;
  knownRevoked: boolean;
  now: number;
  maxObservedTime: number | null;
  maxPermitLifetimeSeconds: number;
  captureEarliest: number;
  captureLatest: number;
  maxOfflineSeconds: number;
  // 接続資格の世代は別の認証機構が扱う。Permitの失効条件へ暗黙に流用しない候補。
  credentialVersion: number;
  controlOnline: boolean;
  uploadAvailable: boolean;
  spoolReservedBytes: number;
  spoolUsedBytes: number;
  memoryUploadBytes: number;
  allowedAdapters: readonly string[];
  maxChunkBytes: number;
  namespaceId: string;
  scope: CandidateScope;
}
const ajv = new Ajv2020({ strict: true, allErrors: false });
for (const [name, format] of Object.entries(fullFormats))
  ajv.addFormat(name, format);
const root = new URL(
  "../../docs/proposals/capture-permit-v2/",
  import.meta.url,
);
const claimsSchema = ajv.compile<Candidate>(
  JSON.parse(
    readFileSync(new URL("claims.schema.json", root), "utf8"),
  ) as object,
);
const scopeSchema = ajv.compile<CandidateScope>(
  JSON.parse(
    readFileSync(new URL("scope.schema.json", root), "utf8"),
  ) as object,
);

// 比較例の入力値を返す。例示の30分・容量を本番の既定値や耐障害保証とはしない。
export function samplePolicy(): CandidatePolicy {
  const value = structuredClone(example);
  return {
    issuer: value.claims.iss,
    tenantId: value.claims.tenantId,
    environment: value.claims.environment,
    nodeId: value.claims.nodeId,
    role: "tuner",
    authorizationEpoch: value.claims.authorizationEpoch,
    assignmentEpoch: value.claims.assignmentEpoch,
    reservationId: value.claims.reservationId,
    reservationRevision: value.claims.reservationRevision,
    recordingId: value.claims.recordingId,
    attemptId: value.claims.attemptId,
    backendId: value.claims.backendId,
    serviceKey: value.claims.serviceKey,
    captureScope: value.claims.captureScope,
    allowMultiplex: false,
    anchorKnown: true,
    knownRevoked: false,
    now: value.claims.iat + 1,
    maxObservedTime: value.claims.iat,
    maxPermitLifetimeSeconds: 3600,
    captureEarliest: value.claims.nbf,
    captureLatest: value.claims.exp,
    maxOfflineSeconds: 1800,
    credentialVersion: 1,
    controlOnline: true,
    uploadAvailable: true,
    spoolReservedBytes: value.claims.spoolMaxBytes,
    spoolUsedBytes: 0,
    memoryUploadBytes: 1048576,
    allowedAdapters: [value.scope.adapterId],
    maxChunkBytes: value.scope.maxChunkBytes,
    namespaceId: value.scope.namespaceId,
    scope: value.scope,
  };
}

// v2の構造と提案内の境界条件だけを確認する。成功でも署名・認可・録画を完了したとは扱わない。
export function candidateOutcome(
  value: unknown,
  policy: CandidatePolicy,
): "model-rejected" | "model-waiting" | "model-online" | "model-offline" {
  try {
    const issuer = new URL(policy.issuer);
    if (
      issuer.protocol !== "https:" ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash
    )
      return "model-rejected";
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") > 8192 ||
      !claimsSchema(value) ||
      !scopeSchema(policy.scope)
    )
      return "model-rejected";
    if (
      !policy.anchorKnown ||
      policy.knownRevoked ||
      policy.role !== "tuner" ||
      policy.maxObservedTime === null
    )
      return "model-rejected";
    for (const number of [
      policy.now,
      policy.maxObservedTime,
      policy.authorizationEpoch,
      policy.assignmentEpoch,
      policy.reservationRevision,
      policy.maxPermitLifetimeSeconds,
      policy.captureEarliest,
      policy.captureLatest,
      policy.maxOfflineSeconds,
      policy.credentialVersion,
      policy.spoolReservedBytes,
      policy.spoolUsedBytes,
      policy.memoryUploadBytes,
      policy.maxChunkBytes,
    ])
      if (!Number.isSafeInteger(number) || number < 0) return "model-rejected";
    const bindings: readonly [keyof Candidate, keyof CandidatePolicy][] = [
      ["iss", "issuer"],
      ["sub", "nodeId"],
      ["nodeId", "nodeId"],
      ["tenantId", "tenantId"],
      ["environment", "environment"],
      ["authorizationEpoch", "authorizationEpoch"],
      ["assignmentEpoch", "assignmentEpoch"],
      ["reservationId", "reservationId"],
      ["reservationRevision", "reservationRevision"],
      ["recordingId", "recordingId"],
      ["attemptId", "attemptId"],
      ["backendId", "backendId"],
      ["serviceKey", "serviceKey"],
      ["captureScope", "captureScope"],
    ];
    if (bindings.some(([field, expected]) => value[field] !== policy[expected]))
      return "model-rejected";
    if (
      policy.now < policy.maxObservedTime ||
      value.iat > policy.now ||
      value.iat > value.nbf ||
      value.exp <= value.nbf ||
      value.exp - value.iat > policy.maxPermitLifetimeSeconds ||
      value.nbf < policy.captureEarliest ||
      value.exp > policy.captureLatest ||
      value.offlineAllowedUntil < value.nbf ||
      value.offlineAllowedUntil > value.exp ||
      value.offlineAllowedUntil - value.iat > policy.maxOfflineSeconds ||
      value.spoolMaxBytes > policy.spoolReservedBytes ||
      (value.captureScope === "multiplex" && !policy.allowMultiplex)
    )
      return "model-rejected";
    const scope = policy.scope;
    if (
      scope.scopeId !== value.storageScopeId ||
      scope.namespaceId !== policy.namespaceId ||
      !policy.allowedAdapters.includes(scope.adapterId) ||
      scope.tenantId !== value.tenantId ||
      scope.environment !== value.environment ||
      scope.nodeId !== value.nodeId ||
      scope.recordingId !== value.recordingId ||
      scope.attemptId !== value.attemptId ||
      scope.prefix !==
        `recordings/${value.recordingId}/attempts/${value.attemptId}/` ||
      scope.maxChunkBytes > policy.maxChunkBytes
    )
      return "model-rejected";
    if (policy.now >= value.exp) return "model-rejected";
    if (policy.now < value.nbf) return "model-waiting";
    if (policy.controlOnline && policy.uploadAvailable)
      return policy.memoryUploadBytes > 0 ? "model-online" : "model-rejected";
    return policy.now < value.offlineAllowedUntil &&
      value.spoolMaxBytes > 0 &&
      policy.spoolUsedBytes < value.spoolMaxBytes
      ? "model-offline"
      : "model-rejected";
  } catch {
    return "model-rejected";
  }
}
