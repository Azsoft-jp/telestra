// 合成した録画許可と信頼済みpolicyの期待値。秘密値と実番組の情報を含めない。
import example from "../../docs/proposals/capture-permit-v2/example.json" with { type: "json" };
import type { ControlMap } from "../../packages/control-contracts/index.ts";
export const permitClaims: ControlMap["CapturePermitV2"] =
  example.claims as ControlMap["CapturePermitV2"];
// Credentialと接続の世代は含めず、失効と割当の期待値だけを独立して照合する。
export const permitContext: ControlMap["CapturePermitV2Context"] = {
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
  now: permitClaims.iat,
  maxObservedTime: permitClaims.iat,
  maxPermitLifetime: 3600,
  maxOfflineSeconds: 1800,
  captureEarliest: permitClaims.nbf,
  captureLatest: permitClaims.exp,
  maxSpoolBytes: permitClaims.spoolMaxBytes,
  anchorKnown: true,
  revoked: false,
};
