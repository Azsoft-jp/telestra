// 制御種別ごとの構造と期限を確認し、Permitの構造検証を実行許可と混同しない。
import assert from "node:assert/strict";
import { validateEnvelope } from "../../packages/control-contracts/channel.ts";
import { scenario } from "../evidence.ts";

scenario(
  "CORE-02",
  "signed-control-type-and-permit-boundaries",
  "synthetic-control-payloads-v1",
  "型別payload、時刻、ACK対応、PermitのNode・scopeを照合し、未知操作・不整合を拒否する",
  () => {
    const now = 1793232000;
    const envelope = (type: string, kind: string, payload: unknown) => ({
      protocolVersion: 1,
      messageId: "message-local-01",
      kind,
      type,
      nodeId: "tuner-local-01",
      sessionEpoch: 1,
      issuedAt: new Date(now * 1000).toISOString(),
      expiresAt: new Date((now + 30) * 1000).toISOString(),
      payload,
    });
    const permit = {
      schemaVersion: 1,
      keyId: "synthetic-key",
      algorithm: "Ed25519",
      signature: "s".repeat(64),
      claims: {
        permitId: "permit-local-01",
        nodeId: "tuner-local-01",
        recordingId: "recording-local-01",
        attemptId: "attempt-local-01",
        serviceKey: "service-local-01",
        captureScope: "service-filtered",
        issuedAt: new Date(now * 1000).toISOString(),
        notBefore: new Date(now * 1000).toISOString(),
        notAfter: new Date((now + 300) * 1000).toISOString(),
        offlineAllowedUntil: new Date((now + 300) * 1000).toISOString(),
        spoolMaxBytes: 1024,
        storageGrantRef: "grant-local-01",
      },
    };
    const start = envelope("capture.start", "command", { permit });
    assert.equal(validateEnvelope(start, now).type, "capture.start");
    assert.equal(
      validateEnvelope(
        envelope("capture.cancel", "command", {
          recordingId: "recording-local-01",
          attemptId: "attempt-local-01",
        }),
        now,
      ).type,
      "capture.cancel",
    );
    const ack = {
      ...envelope("command.ack", "ack", {
        accepted: false,
        code: "not implemented",
      }),
      correlationId: "command-local-01",
    };
    assert.equal(validateEnvelope(ack, now).type, "command.ack");
    const heartbeat = envelope("node.heartbeat", "event", {
      uptimeSeconds: 0,
      spoolBytes: 0,
    });
    for (const invalid of [
      { ...heartbeat, type: "shell.exec" },
      {
        ...heartbeat,
        payload: { uptimeSeconds: 0, spoolBytes: 0, filePath: "/tmp/input" },
      },
      { ...heartbeat, expiresAt: new Date(now * 1000).toISOString() },
      { ...heartbeat, expiresAt: new Date((now + 31) * 1000).toISOString() },
      { ...heartbeat, issuedAt: "2016-12-31T23:59:60Z" },
      { ...heartbeat, sessionEpoch: 9007199254740992 },
      { ...ack, correlationId: undefined },
      { ...ack, payload: { accepted: true, code: "not implemented" } },
      {
        ...start,
        payload: {
          permit: {
            ...permit,
            claims: { ...permit.claims, nodeId: "tuner-other-01" },
          },
        },
      },
      {
        ...start,
        payload: {
          permit: {
            ...permit,
            claims: { ...permit.claims, captureScope: undefined },
          },
        },
      },
    ])
      assert.throws(() => validateEnvelope(invalid, now));
  },
);
