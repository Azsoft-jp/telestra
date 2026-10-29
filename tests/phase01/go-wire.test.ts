// GoプロセスとWorkerの制御契約を照合する。鍵・TokenはIPCで受け渡し、証跡には出力しない。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportJWK, SignJWT } from "jose";
import { fixture, tenantId } from "./helper.ts";
import { enroll, openNode } from "./socket.ts";
import { validateControl } from "../../packages/control-contracts/index.ts";
import type { ControlMap } from "../../packages/control-contracts/index.ts";
import { scenario } from "../evidence.ts";

// 実行パスと引数を固定し、失敗時も標準入出力の内容を例外へ含めない。
function go(value: unknown): {
  ok: boolean;
  valid?: boolean;
  proof?: string;
  hello?: string;
  heartbeat?: string;
  ack?: string;
} {
  const result = spawnSync("go", ["run", "./nodes/tuner/cmd/wirefixture"], {
    input: JSON.stringify(value),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 131_072,
    env: {
      ...process.env,
      GOTOOLCHAIN: "local",
      GOPROXY: "off",
      GOSUMDB: "off",
    },
  });
  assert.equal(result.status, 0, "Goの契約試験プロセスが失敗しました。");
  try {
    return JSON.parse(result.stdout) as ReturnType<typeof go>;
  } catch {
    throw new Error("Goの契約試験の応答を解析できません。");
  }
}
function required(value: string | undefined): string {
  if (typeof value !== "string")
    throw new Error("Goの署名付き応答がありません。");
  return value;
}

scenario(
  "NODE-01",
  "go-worker-proof-events-and-ack",
  "memory-keys-go-worker-exchange-v1",
  "Goの接続証明・hello・Heartbeat・未実装ACKをWorkerが検証し、GoもWorkerの署名を検証する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-go-wire-01");
      const key = await exportJWK(enrolled.target.privateKey);
      const base = {
        mode: "exchange",
        issuer: context.bindings.TELESTRA_CONTROL_ISSUER,
        keys: [context.signer.publicJwk],
        identity: {
          NodeID: enrolled.target.nodeId,
          TenantID: tenantId,
          Environment: "development",
          Role: "tuner",
        },
        credential: enrolled.credential.accessToken,
        now: context.now(),
        lastEpoch: 0,
        privateSeed: key.d,
        deviceKid: enrolled.target.publicJwk.kid,
        messages: [] as string[],
      };
      const proof = go(base);
      assert.equal(proof.ok, true);
      const client = await openNode(
        context,
        enrolled,
        enrolled.credential.accessToken,
        required(proof.proof),
      );
      const ready = go({
        ...base,
        now: context.now(),
        messages: [client.rawReady],
      });
      assert.equal(ready.ok, true);
      client.socket.send(required(ready.hello));
      assert.equal((await client.next()).type, "control.receipt");
      client.socket.send(required(ready.heartbeat));
      assert.equal((await client.next()).type, "control.receipt");
      const command = {
        commandId: "command-go-wire-01",
        type: "capture.cancel",
        payload: { recordingId: "rec-owned-01", attemptId: "attempt-local-01" },
        expiresAt: new Date((context.now() + 25) * 1000).toISOString(),
      };
      assert.equal(
        (
          await context.browser(
            `/nodes/${enrolled.target.nodeId}/commands`,
            enrolled.operator,
            { method: "POST", body: command },
          )
        ).status,
        202,
      );
      const rawCommand = await client.nextRaw();
      const ack = go({
        ...base,
        now: context.now(),
        messages: [client.rawReady, rawCommand],
      });
      assert.equal(ack.ok, true);
      client.socket.send(required(ack.ack));
      assert.equal((await client.next()).type, "control.receipt");
      const response = await context.browser(
        `/nodes/${enrolled.target.nodeId}/commands`,
        enrolled.operator,
        { method: "POST", body: command },
      );
      assert.deepEqual(((await response.json()) as { result: object }).result, {
        accepted: false,
        code: "not implemented",
      });
      assert.equal(context.egress, 0);
      client.socket.close(1000, "試験終了");
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-03",
  "go-wire-scope-signature-and-epoch-denials",
  "go-worker-negative-control-v1",
  "Goが別家庭・旧接続世代・偽署名・未知操作・期限切れ・資格期限超過を拒否する",
  async () => {
    const context = await fixture();
    try {
      const enrolled = await enroll(context, "tuner-go-denial-01");
      const client = await openNode(context, enrolled);
      const key = await exportJWK(enrolled.target.privateKey);
      const now = context.now();
      const envelope = {
        protocolVersion: 1,
        messageId: "command-go-denial-01",
        kind: "command",
        type: "capture.cancel",
        nodeId: enrolled.target.nodeId,
        sessionEpoch: client.sessionEpoch,
        issuedAt: new Date(now * 1000).toISOString(),
        expiresAt: new Date((now + 30) * 1000).toISOString(),
        payload: { recordingId: "rec-owned-01", attemptId: "attempt-local-01" },
      };
      const claims = {
        iss: context.bindings.TELESTRA_CONTROL_ISSUER,
        aud: "tv-node-control",
        sub: enrolled.target.nodeId,
        iat: now,
        exp: now + 30,
        jti: envelope.messageId,
        tenantId,
        environment: "development",
        nodeId: enrolled.target.nodeId,
        credentialVersion: enrolled.credential.credentialVersion,
        direction: "control-to-node",
        envelope,
      };
      const request = {
        mode: "exchange",
        issuer: context.bindings.TELESTRA_CONTROL_ISSUER,
        keys: [context.signer.publicJwk],
        identity: {
          NodeID: enrolled.target.nodeId,
          TenantID: tenantId,
          Environment: "development",
          Role: "tuner",
        },
        credential: enrolled.credential.accessToken,
        now,
        lastEpoch: 0,
        privateSeed: key.d,
        deviceKid: enrolled.target.publicJwk.kid,
      };
      for (const overrides of [
        { tenantId: "foreign-household" },
        { direction: "node-to-control" },
        { credentialVersion: 999 },
        { envelope: { ...envelope, sessionEpoch: 0 } },
        { envelope: { ...envelope, type: "shell.exec" } },
        {
          envelope: {
            ...envelope,
            payload: { ...envelope.payload, url: "http://127.0.0.1/" },
          },
        },
        { exp: now - 1 },
        { exp: now + 301 },
      ]) {
        const raw = await new SignJWT({ ...claims, ...overrides })
          .setProtectedHeader({
            alg: "EdDSA",
            kid: context.signer.publicJwk.kid,
            typ: "tv-control+jwt",
          })
          .sign(context.signer.privateKey);
        assert.equal(
          go({ ...request, messages: [client.rawReady, raw] }).ok,
          false,
        );
      }
      const valid = await new SignJWT(claims)
        .setProtectedHeader({
          alg: "EdDSA",
          kid: context.signer.publicJwk.kid,
          typ: "tv-control+jwt",
        })
        .sign(context.signer.privateKey);
      const parts = valid.split(".");
      parts[2] =
        (parts[2]?.[0] === "A" ? "B" : "A") + (parts[2]?.slice(1) ?? "");
      assert.equal(
        go({ ...request, messages: [client.rawReady, parts.join(".")] }).ok,
        false,
      );
      assert.equal(
        go({
          ...request,
          lastEpoch: client.sessionEpoch,
          messages: [client.rawReady],
        }).ok,
        false,
      );
      client.socket.close(1000, "試験終了");
    } finally {
      await context.close();
    }
  },
);

scenario(
  "CORE-02",
  "go-ajv-shared-payload-cases",
  "shared-schema-payload-matrix-v1",
  "Goへ生成した契約とAjvで、正常・未知項目・数値境界・重複能力の判定を照合する",
  () => {
    const hello = {
      agentVersion: "test",
      nodeRole: "tuner",
      backend: "synthetic",
      capabilities: ["capture"],
      maxConcurrentJobs: 1,
    };
    const cases: [keyof ControlMap, unknown][] = [
      ["WsHello", hello],
      ["WsHello", { ...hello, capabilities: ["capture", "capture"] }],
      ["WsHello", { ...hello, maxConcurrentJobs: 17 }],
      ["WsHello", { ...hello, shell: "id" }],
      ["WsHeartbeat", { uptimeSeconds: 0, spoolBytes: 0 }],
      ["WsHeartbeat", { uptimeSeconds: -1, spoolBytes: 0 }],
      ["WsHeartbeat", { uptimeSeconds: 1, spoolBytes: 9007199254740992 }],
      [
        "WsCaptureCancel",
        { recordingId: "recording-local-01", attemptId: "attempt-local-01" },
      ],
      ["WsCaptureCancel", { recordingId: "recording-local-01" }],
      ["WsCommandAck", { accepted: false, code: "not implemented" }],
      ["WsCommandAck", { accepted: false, code: "unknown" }],
      [
        "PublicJwk",
        { kty: "OKP", crv: "Ed25519", x: "A".repeat(43), kid: "key-local-01" },
      ],
      [
        "PublicJwk",
        { kty: "RSA", crv: "Ed25519", x: "A".repeat(43), kid: "key-local-01" },
      ],
    ];
    for (const [definition, value] of cases) {
      let expected = true;
      try {
        validateControl(definition, value);
      } catch {
        expected = false;
      }
      assert.equal(
        go({ mode: "validate", definition, value }).valid ?? false,
        expected,
        definition,
      );
    }
  },
);

scenario(
  "CORE-02",
  "go-contract-generator-fails-closed",
  "unsupported-go-schema-keywords-v1",
  "Goで未対応のSchema、typeなしの制約、$refの兄弟制約を生成時に拒否する",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "tv-go-schema-"));
    try {
      mkdirSync(join(directory, "contracts"));
      mkdirSync(join(directory, "nodes/tuner/wire"), { recursive: true });
      const baseline = readFileSync("contracts/control.schema.json", "utf8");
      writeFileSync(
        join(directory, "contracts/capture-permit.schema.json"),
        readFileSync("contracts/capture-permit.schema.json"),
      );
      writeFileSync(
        join(directory, "contracts/capture-permit-v2.schema.json"),
        readFileSync("contracts/capture-permit-v2.schema.json"),
      );
      const generate = () =>
        spawnSync(
          process.execPath,
          [resolve("scripts/generate-go-control.mjs")],
          { cwd: directory, encoding: "utf8", timeout: 30_000 },
        );
      writeFileSync(join(directory, "contracts/control.schema.json"), baseline);
      assert.equal(generate().status, 0);
      for (const unsupported of [
        { type: "object", allOf: [] },
        { type: ["string", "null"] },
        { minimum: 1 },
        { $ref: "#/$defs/PublicJwk", maxProperties: 1 },
        { type: "string", format: "uri" },
        { type: "string", pattern: "(?=a)a" },
      ]) {
        const schema = JSON.parse(baseline) as {
          $defs: Record<string, unknown>;
        };
        schema.$defs.Unsupported = unsupported;
        writeFileSync(
          join(directory, "contracts/control.schema.json"),
          JSON.stringify(schema),
        );
        assert.equal(generate().status, 1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
