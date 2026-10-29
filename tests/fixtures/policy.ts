// 合成したpolicyのfixture。鍵・資格・実番組・実環境の識別情報を含めない。
import { permitClaims, permitContext } from "./permit.ts";
import type { ControlMap } from "../../packages/control-contracts/index.ts";
// policyに時計を埋め込んでNodeの現在時刻と誤認させず、許可の限界だけを署名対象にする。
export const policyClaims: ControlMap["CapturePolicyV2"] = {
  schemaVersion: 2,
  iss: permitClaims.iss,
  aud: "telestra-tuner-capture-policy",
  sub: permitClaims.nodeId,
  jti: "policy-synthetic-01",
  iat: permitClaims.iat,
  exp: permitClaims.exp,
  tenantId: permitClaims.tenantId,
  environment: permitClaims.environment,
  nodeId: permitClaims.nodeId,
  nodeRole: "tuner",
  authorizationEpoch: permitClaims.authorizationEpoch,
  assignmentEpoch: permitClaims.assignmentEpoch,
  reservationId: permitClaims.reservationId,
  reservationRevision: permitClaims.reservationRevision,
  recordingId: permitClaims.recordingId,
  attemptId: permitClaims.attemptId,
  backendId: permitClaims.backendId,
  serviceKey: permitClaims.serviceKey,
  captureScope: permitClaims.captureScope,
  storageScopeId: permitClaims.storageScopeId,
  permitId: permitClaims.jti,
  maxPermitLifetime: permitContext.maxPermitLifetime,
  maxOfflineSeconds: permitContext.maxOfflineSeconds,
  captureEarliest: permitContext.captureEarliest,
  captureLatest: permitContext.captureLatest,
  maxSpoolBytes: permitContext.maxSpoolBytes,
  revoked: false,
};
