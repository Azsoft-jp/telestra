// 型別payload、サイズ、時刻、主体の境界を正常例と拒否例で検証する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseEnvelope,
  validate,
  BoundaryError,
} from "../packages/contracts/index.ts";
import { scenario } from "./evidence.ts";
import type { NodePayloadMap } from "../packages/contracts/generated.ts";

const hello = JSON.parse(
  readFileSync("examples/node.hello.json", "utf8"),
) as Record<string, unknown>;
const context = {
  nodeId: "tuner-demo-01",
  sessionEpoch: 1,
  now: Date.parse("2026-10-29T00:00:30Z"),
  allowedTypes: ["node.hello"] as const,
};

scenario(
  "CORE-02",
  "envelope-boundaries",
  "node.hello.json",
  "型別payload・サイズ・期限・node境界を拒否する",
  () => {
    assert.equal(
      parseEnvelope(JSON.stringify(hello), context).type,
      "node.hello",
    );
    const reject = (value: unknown) =>
      assert.throws(
        () => parseEnvelope(JSON.stringify(value), context),
        BoundaryError,
      );
    reject({ ...hello, type: "shell.exec" });
    reject({ ...hello, payload: {} });
    reject({ ...hello, payload: { ...(hello.payload as object), exec: "id" } });
    reject({ ...hello, kind: "command" });
    reject({ ...hello, expiresAt: "2026-10-29T00:00:30Z" });
    reject({ ...hello, issuedAt: "2026-10-29T00:00:31Z" });
    reject({ ...hello, issuedAt: "invalid" });
    reject({ ...hello, expiresAt: "2026-10-29T00:00:00Z" });
    reject({ ...hello, nodeId: "other-node" });
    reject({ ...hello, sessionEpoch: 0 });
    assert.throws(
      () => parseEnvelope(" ".repeat(65_537), context),
      BoundaryError,
    );
    assert.throws(() => parseEnvelope("{broken", context), BoundaryError);
  },
);

scenario(
  "CORE-02",
  "unrepresentable-timestamps",
  "node.hello.json + RFC3339-leap-second",
  "数値化できない発行・期限日時を拒否し、UTCと同じ時刻のoffset表記は許可する",
  () => {
    for (const field of ["issuedAt", "expiresAt"] as const) {
      const value = { ...hello, [field]: "2016-12-31T23:59:60Z" };
      // RFC3339はうるう秒を許すが、Date.parseでは数値化できないため拒否を確認する。
      const validated = validate("node-envelope", value);
      assert.ok(Number.isNaN(Date.parse(validated[field])));
      assert.throws(
        () => parseEnvelope(JSON.stringify(value), context),
        BoundaryError,
      );
    }
    assert.equal(
      parseEnvelope(
        JSON.stringify({
          ...hello,
          issuedAt: "2026-10-29T09:00:00+09:00",
          expiresAt: "2026-10-29T09:01:00+09:00",
        }),
        context,
      ).type,
      "node.hello",
    );
    const invalidClock = { ...context, now: Number.NaN };
    assert.throws(
      () => parseEnvelope(JSON.stringify(hello), invalidClock),
      BoundaryError,
    );
    assert.throws(
      () =>
        parseEnvelope(JSON.stringify(hello), {
          ...context,
          now: Number.POSITIVE_INFINITY,
        }),
      BoundaryError,
    );
  },
);

scenario(
  "CORE-02",
  "full-schema-validation",
  "deployment.dual-static.json",
  "Draft 2020-12の条件・format・未知フィールドを検証する",
  () => {
    const profile = JSON.parse(
      readFileSync("examples/deployment.dual-static.json", "utf8"),
    ) as { frontend: Record<string, unknown> };
    validate("deployment-profile", profile);
    delete profile.frontend.secondaryOrigin;
    assert.throws(() => validate("deployment-profile", profile), BoundaryError);
    assert.throws(
      () =>
        validate("node-envelope", {
          ...hello,
          issuedAt: "2026-02-30T00:00:00Z",
        }),
      BoundaryError,
    );
    assert.throws(
      () => validate("node-envelope", { ...hello, unexpected: true }),
      BoundaryError,
    );
  },
);

scenario(
  "CORE-02",
  "all-type-specific-payloads",
  "mock-control-v1",
  "全12種のpayloadを検証し、未知フィールド・役割外メッセージを拒否する",
  () => {
    const permit = {
      schemaVersion: 1 as const,
      keyId: "mock-key-id",
      algorithm: "Ed25519" as const,
      signature: "x".repeat(86),
      claims: {
        permitId: "mock-permit-01",
        nodeId: "tuner-demo-01",
        recordingId: "rec-demo-01",
        attemptId: "attempt-demo-01",
        serviceKey: "service-demo-01",
        issuedAt: "2026-10-29T00:00:00Z",
        notBefore: "2026-10-29T00:00:00Z",
        notAfter: "2026-10-29T00:01:00Z",
        offlineAllowedUntil: "2026-10-29T00:01:00Z",
        spoolMaxBytes: 4096,
        storageGrantRef: "grant-demo-01",
      },
    };
    const samples: NodePayloadMap = {
      "node.hello": {
        agentVersion: "mock",
        backend: "mirakurun-mock",
        capabilities: ["capture"],
        maxConcurrentCaptures: 1,
      },
      "node.heartbeat": { uptimeSeconds: 1, spoolBytes: 0 },
      "node.status": { state: "waiting", detail: "待機中" },
      "reservation.snapshot": { revision: 1, permits: [permit] },
      "capture.start": { permit },
      "capture.cancel": {
        recordingId: "rec-demo-01",
        attemptId: "attempt-demo-01",
      },
      "capture.status": {
        recordingId: "rec-demo-01",
        attemptId: "attempt-demo-01",
        state: "recording",
      },
      "encode.start": {
        jobId: "job-demo-01",
        recordingId: "rec-demo-01",
        attemptId: "attempt-demo-01",
        profile: "mock-only",
        sourceManifestSha256: "0".repeat(64),
      },
      "encode.cancel": { jobId: "job-demo-01" },
      "encode.status": { jobId: "job-demo-01", state: "waiting" },
      "epg.delta": {
        backend: "mirakc-mock",
        revision: 1,
        programIds: ["program-demo-01"],
      },
      "command.ack": { accepted: false, code: "not implemented" },
    };
    const schema = JSON.parse(
      readFileSync("contracts/node-envelope.schema.json", "utf8"),
    ) as { properties: { type: { enum: string[] } } };
    assert.deepEqual(
      Object.keys(samples).sort(),
      [...schema.properties.type.enum].sort(),
    );
    for (const type of Object.keys(samples) as (keyof NodePayloadMap)[]) {
      const kind =
        type === "command.ack"
          ? "ack"
          : [
                "capture.start",
                "capture.cancel",
                "encode.start",
                "encode.cancel",
                "reservation.snapshot",
              ].includes(type)
            ? "command"
            : "event";
      const envelope = {
        ...hello,
        type,
        kind,
        correlationId: "correlation-0001",
        payload: samples[type],
      };
      assert.equal(
        parseEnvelope(JSON.stringify(envelope), {
          ...context,
          allowedTypes: [type],
        }).type,
        type,
      );
      assert.throws(
        () =>
          parseEnvelope(
            JSON.stringify({
              ...envelope,
              payload: { ...samples[type], forbidden: true },
            }),
            { ...context, allowedTypes: [type] },
          ),
        BoundaryError,
      );
    }
    assert.throws(
      () =>
        parseEnvelope(JSON.stringify(hello), { ...context, allowedTypes: [] }),
      BoundaryError,
    );
    assert.throws(
      () =>
        parseEnvelope(
          JSON.stringify({
            ...hello,
            payload: { ...samples["node.hello"], maxConcurrentCaptures: 17 },
          }),
          context,
        ),
      BoundaryError,
    );
    assert.throws(
      () => parseEnvelope("あ".repeat(21_846), context),
      BoundaryError,
    );
  },
);
