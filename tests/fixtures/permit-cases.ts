// v2の同一入力をNode・Go・Workerへ渡す。表示用ラベルに署名やclaimsの値を含めない。
import { CompactSign } from "jose";
import { permitClaims, permitContext } from "./permit.ts";
export interface PermitCase {
  label: string;
  token: string;
  context: unknown;
  expected: "active" | "waiting" | "rejected";
}
export async function permitCases(
  key: CryptoKey,
  kid: string,
): Promise<PermitCase[]> {
  const header = { alg: "Ed25519", typ: "telestra-capture-permit-v2+jwt", kid };
  const text = new TextEncoder();
  const sign = (body: unknown, overrides = {}) =>
    new CompactSign(text.encode(JSON.stringify(body)))
      .setProtectedHeader({ ...header, ...overrides })
      .sign(key);
  // raw JSONの異常も正しい暗号署名で包み、暗号検証後の拒否を試験する。
  const raw = async (head: string, body: Uint8Array) => {
    const input = `${Buffer.from(head).toString("base64url")}.${Buffer.from(body).toString("base64url")}`;
    return `${input}.${Buffer.from(await crypto.subtle.sign("Ed25519", key, text.encode(input))).toString("base64url")}`;
  };
  const cases: PermitCase[] = [];
  const add = (
    label: string,
    token: string,
    expected: PermitCase["expected"] = "rejected",
    context: unknown = permitContext,
  ) => cases.push({ label, token, expected, context });
  const valid = await sign(permitClaims);
  add("valid", valid, "active");
  add(
    "future",
    await sign({ ...permitClaims, nbf: permitContext.now + 1 }),
    "waiting",
  );
  add("at-nbf", valid, "active", { ...permitContext, now: permitClaims.nbf });
  add("at-exp", valid, "rejected", { ...permitContext, now: permitClaims.exp });
  add("offline-boundary-still-needs-execution-policy", valid, "active", {
    ...permitContext,
    now: permitClaims.offlineAllowedUntil,
  });
  for (const field of Object.keys(permitClaims)) {
    const missing = { ...permitClaims } as Record<string, unknown>;
    delete missing[field];
    add(`missing-${field}`, await sign(missing));
  }
  for (const [field, value] of Object.entries({
    iss: "https://other.example.invalid",
    aud: "tv-node-agent",
    sub: "other-node",
    schemaVersion: 1,
    tenantId: "other-tenant",
    environment: "staging",
    nodeId: "other-node",
    nodeRole: "encoder",
    authorizationEpoch: 2,
    assignmentEpoch: 7,
    reservationId: "other-reservation",
    reservationRevision: 1,
    recordingId: "other-recording",
    attemptId: "other-attempt",
    backendId: "other-backend",
    serviceKey: "other-service",
    captureScope: "multiplex",
    storageScopeId: "other-scope",
    iat: permitContext.now + 1,
    nbf: permitClaims.exp,
    exp: permitClaims.exp + 1,
    offlineAllowedUntil: permitClaims.exp + 1,
    spoolMaxBytes: permitContext.maxSpoolBytes + 1,
  }))
    add(`changed-${field}`, await sign({ ...permitClaims, [field]: value }));
  for (const [field, value] of Object.entries(permitClaims)) {
    if (typeof value !== "string") continue;
    add(
      `trailing-newline-${field}`,
      await sign({ ...permitClaims, [field]: value + "\n" }),
    );
  }
  for (const change of [
    { anchorKnown: false },
    { revoked: true },
    { maxObservedTime: permitContext.now + 1 },
    { maxPermitLifetime: 3599 },
    { maxPermitLifetime: 0 },
    { maxOfflineSeconds: 1799 },
    { captureEarliest: permitContext.now + 1 },
    { captureLatest: permitClaims.exp - 1 },
    { maxSpoolBytes: 0 },
    { credentialVersion: 2 },
  ])
    add("context-boundary", valid, "rejected", { ...permitContext, ...change });
  for (const overrides of [
    { alg: "EdDSA" },
    { typ: "tv-node+jwt" },
    { kid: "unknown-key" },
    { jku: "https://example.invalid/keys" },
    { jwk: {} },
    { x5u: "https://example.invalid/cert" },
  ])
    add("header-boundary", await sign(permitClaims, overrides));
  const head = JSON.stringify(header),
    body = JSON.stringify(permitClaims);
  add(
    "header-at-1024",
    await raw(
      head + " ".repeat(1024 - text.encode(head).length),
      text.encode(body),
    ),
    "active",
  );
  add(
    "header-over-1024",
    await raw(
      head + " ".repeat(1025 - text.encode(head).length),
      text.encode(body),
    ),
  );
  // Compact JWS全体の上限でも正しい署名を使い、1byte差による拒否を確認する。
  for (const target of [8192, 8193]) {
    let matched = false;
    for (const headerPadding of [0, 1, 2]) {
      const paddedHead = head + " ".repeat(headerPadding);
      const payloadSize = Math.floor(
        ((target - Buffer.from(paddedHead).toString("base64url").length - 88) *
          3) /
          4,
      );
      for (const size of [payloadSize - 1, payloadSize, payloadSize + 1]) {
        if (size < text.encode(body).length) continue;
        const token = await raw(
          paddedHead,
          text.encode(body + " ".repeat(size - text.encode(body).length)),
        );
        if (token.length === target) {
          add(
            `token-size-${target}`,
            token,
            target === 8192 ? "active" : "rejected",
          );
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) throw new Error("上限付近の合成JWSを作れません。");
  }
  for (const badHeader of [
    head.replace('"alg":', '"alg":"Ed25519","alg":'),
    head.replace('"alg":', '"\\u0061lg":"Ed25519","alg":'),
    JSON.stringify({ ...header, crit: ["extension"], extension: true }),
    JSON.stringify({ ...header, b64: false }),
  ])
    add("raw-header", await raw(badHeader, text.encode(body)));
  for (const badBody of [
    body.replace('"iat":', '"iat":0,"iat":'),
    body.replace('"iat":', '"\\u0069at":0,"iat":'),
    body.replace(`"iat":${permitClaims.iat}`, '"iat":9007199254740991.1'),
    body.replace('"schemaVersion":2', '"schemaVersion":2.0'),
    body.replace('"schemaVersion":2', '"schemaVersion":2e0'),
    body.slice(0, -1) + ',"unknown":true}',
    "[".repeat(34) + "0" + "]".repeat(34),
    body + " true",
    "\uFEFF" + body,
  ])
    add("raw-payload", await raw(head, text.encode(badBody)));
  add("invalid-utf8", await raw(head, new Uint8Array([0x7b, 0xff, 0x7d])));
  add("invalid-json-escape", await raw(head, text.encode('{"iss":"\\uD800"}')));
  add(
    "signed-size-limit",
    await raw(head, text.encode(body + " ".repeat(8192))),
  );
  const parts = valid.split(".");
  add(
    "tamper",
    `${parts[0]}.${parts[1]}.${parts[2]?.[0] === "A" ? "B" : "A"}${parts[2]?.slice(1)}`,
  );
  add("padding", `${parts[0]}=.${parts[1]}.${parts[2]}`);
  add(
    "noncanonical-signature",
    valid.slice(0, -1) +
      (valid.at(-1) === "A"
        ? "B"
        : valid.at(-1) === "Q"
          ? "R"
          : valid.at(-1) === "g"
            ? "h"
            : "x"),
  );
  add("empty", "");
  add("segments", `${valid}.extra`);
  add("unicode", "あ".repeat(8193));
  return cases;
}
