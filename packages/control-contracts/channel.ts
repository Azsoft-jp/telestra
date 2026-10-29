// 署名付き制御の本文を型別に検証し、資格・接続世代・送信方向へ拘束する。
import { validateControl } from "./index.ts";
import type { ControlMap } from "./index.ts";
import { verifyIdentity, authFailure } from "../identity/index.ts";
import type { JWK } from "jose";
import { BoundaryError } from "../contracts/error.ts";

const payloadKinds = {
  "session.ready": "WsSessionReady",
  "node.hello": "WsHello",
  "node.heartbeat": "WsHeartbeat",
  "capture.start": "WsCaptureStart",
  "capture.cancel": "WsCaptureCancel",
  "command.ack": "WsCommandAck",
  "control.receipt": "WsReceipt",
} as const;
export type ChannelType = keyof typeof payloadKinds;
export type ChannelEnvelope = {
  [K in ChannelType]: Omit<ControlMap["WsEnvelope"], "type" | "payload"> & {
    type: K;
    payload: ControlMap[(typeof payloadKinds)[K]];
  };
}[ChannelType];
export interface ChannelContext {
  nodeId: string;
  tenantId: string;
  environment: string;
  credentialVersion: number;
  sessionEpoch: number;
  expiresAt: number;
}

// Schemaに加えてkindと期限を照合し、構造だけが正しい不正命令も拒否する。
export function validateEnvelope(value: unknown, now: number): ChannelEnvelope {
  const envelope = validateControl("WsEnvelope", value);
  validateControl(payloadKinds[envelope.type], envelope.payload);
  const expectedKind =
    envelope.type === "command.ack"
      ? "ack"
      : envelope.type.startsWith("capture.")
        ? "command"
        : "event";
  const issued = Date.parse(envelope.issuedAt);
  const expires = Date.parse(envelope.expiresAt);
  if (
    envelope.kind !== expectedKind ||
    (envelope.type === "command.ack") !==
      (envelope.correlationId !== undefined) ||
    !Number.isSafeInteger(envelope.sessionEpoch) ||
    !Number.isFinite(now) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > now * 1000 ||
    expires <= now * 1000 ||
    expires <= issued ||
    expires - issued > 30_000
  )
    throw new BoundaryError(
      "INVALID_CONTROL",
      "制御の種別・世代・期限を確認してください。",
    );
  if (envelope.type === "command.ack") {
    const ack = validateControl("WsCommandAck", envelope.payload);
    if (ack.accepted !== (ack.code === "accepted"))
      throw new BoundaryError("INVALID_ACK", "応答の結果が一致しません。");
  }
  if (envelope.type === "capture.start") {
    const capture = validateControl("WsCaptureStart", envelope.payload);
    if (
      capture.permit.claims.nodeId !== envelope.nodeId ||
      capture.permit.claims.captureScope === undefined
    )
      throw new BoundaryError(
        "INVALID_CAPTURE_TARGET",
        "録画許可のNodeと対象範囲を確認してください。",
      );
  }
  return envelope as ChannelEnvelope;
}

// 既知の鍵だけを使い、別方向・別家庭・旧接続・別Token用途の本文を拒否する。
export async function verifyControl(
  raw: string,
  expected: ChannelContext & {
    direction: "node-to-control" | "control-to-node";
  },
  keys: { keys: JWK[] },
  issuer: string,
  now: number,
): Promise<ChannelEnvelope> {
  const claims = await verifyIdentity("ControlClaims", raw, {
    issuer,
    audience:
      expected.direction === "node-to-control"
        ? "tv-control-plane"
        : "tv-node-control",
    typ: "tv-control+jwt",
    jwks: keys,
    now,
    maxLifetime: 30,
  });
  const envelope = validateEnvelope(claims.envelope, now);
  if (
    claims.sub !== expected.nodeId ||
    claims.nodeId !== expected.nodeId ||
    claims.tenantId !== expected.tenantId ||
    claims.environment !== expected.environment ||
    claims.credentialVersion !== expected.credentialVersion ||
    !Number.isSafeInteger(expected.expiresAt) ||
    now >= expected.expiresAt ||
    claims.exp > expected.expiresAt ||
    claims.direction !== expected.direction ||
    envelope.nodeId !== expected.nodeId ||
    envelope.sessionEpoch !== expected.sessionEpoch ||
    claims.jti !== envelope.messageId ||
    Date.parse(envelope.issuedAt) !== claims.iat * 1000 ||
    Date.parse(envelope.expiresAt) !== claims.exp * 1000
  )
    throw authFailure();
  return envelope;
}
