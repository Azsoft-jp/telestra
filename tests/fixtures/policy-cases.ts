// 同一の署名済み入力でNode・Go・workerdを照合する。値を診断ラベルへ含めない。
import { CompactSign } from "jose";
import { policyClaims } from "./policy.ts";
import { permitClaims, permitContext } from "./permit.ts";
export interface PolicyCase {
  label: string;
  policy: string;
  permit: string;
  now: number;
  maxObserved: number;
  expected: "active" | "waiting" | "rejected";
}
export async function policyCases(
  policyKey: CryptoKey,
  permitKey: CryptoKey,
  policyKid: string,
  permitKid: string,
): Promise<PolicyCase[]> {
  const text = new TextEncoder();
  const policyHeader = {
    alg: "Ed25519",
    typ: "telestra-capture-policy-v2+jwt",
    kid: policyKid,
  };
  const signPolicy = (claims: unknown, head = {}) =>
    new CompactSign(text.encode(JSON.stringify(claims)))
      .setProtectedHeader({ ...policyHeader, ...head })
      .sign(policyKey);
  const signPermit = (claims: unknown) =>
    new CompactSign(text.encode(JSON.stringify(claims)))
      .setProtectedHeader({
        alg: "Ed25519",
        typ: "telestra-capture-permit-v2+jwt",
        kid: permitKid,
      })
      .sign(permitKey);
  const raw = async (header: string, body: Uint8Array) => {
    const input = `${Buffer.from(header).toString("base64url")}.${Buffer.from(body).toString("base64url")}`;
    return `${input}.${Buffer.from(await crypto.subtle.sign("Ed25519", policyKey, text.encode(input))).toString("base64url")}`;
  };
  const policy = await signPolicy(policyClaims),
    permit = await signPermit(permitClaims),
    cases: PolicyCase[] = [];
  const add = (
    label: string,
    candidate: string,
    expected: PolicyCase["expected"] = "rejected",
    changedPermit = permit,
    now = permitContext.now,
    maxObserved = permitContext.maxObservedTime,
  ) =>
    cases.push({
      label,
      policy: candidate,
      permit: changedPermit,
      now,
      maxObserved,
      expected,
    });
  add("valid", policy, "active");
  add(
    "future-permit",
    policy,
    "waiting",
    await signPermit({ ...permitClaims, nbf: permitContext.now + 1 }),
  );
  for (const field of Object.keys(policyClaims)) {
    const missing = { ...policyClaims } as Record<string, unknown>;
    delete missing[field];
    add(`missing-${field}`, await signPolicy(missing));
  }
  for (const [field, value] of Object.entries({
    iss: "https://other.example.invalid",
    aud: "tv-node-agent",
    sub: "other-node",
    tenantId: "other-tenant",
    environment: "staging",
    nodeId: "other-node",
    nodeRole: "encoder",
    authorizationEpoch: 1,
    assignmentEpoch: 1,
    reservationId: "other-reservation",
    reservationRevision: 1,
    recordingId: "other-recording",
    attemptId: "other-attempt",
    backendId: "other-backend",
    serviceKey: "other-service",
    captureScope: "multiplex",
    storageScopeId: "other-scope",
    permitId: "other-permit",
    revoked: true,
    maxSpoolBytes: 0,
    maxPermitLifetime: 0,
    maxOfflineSeconds: 3601,
    captureEarliest: permitContext.now + 1,
    captureLatest: permitClaims.exp - 1,
    iat: permitContext.now + 1,
    exp: permitContext.now,
  })) {
    add(
      `changed-${field}`,
      await signPolicy({ ...policyClaims, [field]: value }),
    );
  }
  add(
    "policy-expires-before-permit",
    await signPolicy({ ...policyClaims, exp: permitClaims.exp - 1 }),
  );
  for (const [field, value] of Object.entries(policyClaims))
    if (typeof value === "string")
      add(
        `trailing-newline-${field}`,
        await signPolicy({ ...policyClaims, [field]: value + "\n" }),
      );
  for (const header of [
    { typ: "telestra-capture-permit-v2+jwt" },
    { alg: "EdDSA" },
    { kid: "unknown-policy-key" },
    { jku: "https://example.invalid/keys" },
    { jwk: {} },
  ])
    add("header-boundary", await signPolicy(policyClaims, header));
  const head = JSON.stringify(policyHeader),
    body = JSON.stringify(policyClaims);
  for (const malformed of [
    body.replace('"iat":', '"iat":0,"iat":'),
    body.replace('"iat":', '"\\u0069at":0,"iat":'),
    body.replace('"schemaVersion":2', '"schemaVersion":2.0'),
    body.replace('"schemaVersion":2', '"schemaVersion":2e0'),
    body.replace(`"iat":${policyClaims.iat}`, '"iat":9007199254740991.1'),
    body.slice(0, -1) + ',"unknown":true}',
    body + " true",
    "\uFEFF" + body,
    "[".repeat(34) + "0" + "]".repeat(34),
  ])
    add("raw-payload", await raw(head, text.encode(malformed)));
  add(
    "duplicate-header",
    await raw(
      head.replace('"alg":', '"alg":"Ed25519","alg":'),
      text.encode(body),
    ),
  );
  add("invalid-utf8", await raw(head, new Uint8Array([0x7b, 0xff, 0x7d])));
  add("oversized", await raw(head, text.encode(body + " ".repeat(8192))));
  add(
    "clock-backward",
    policy,
    "rejected",
    permit,
    permitContext.now,
    permitContext.now + 1,
  );
  add(
    "at-policy-expiry",
    policy,
    "rejected",
    permit,
    policyClaims.exp,
    permitContext.now,
  );
  add(
    "changed-permit-id",
    policy,
    "rejected",
    await signPermit({ ...permitClaims, jti: "other-permit-id" }),
  );
  // 署名は発行済みsnapshotの正当性だけを示す。履歴の巻き戻り検出は確定保存の段階で別に必要。
  const priorPermit = {
    ...permitClaims,
    jti: "permit-historical-01",
    authorizationEpoch: 2,
    assignmentEpoch: 7,
  };
  add(
    "historical-pair-is-not-freshness-proof",
    await signPolicy({
      ...policyClaims,
      jti: "policy-historical-01",
      permitId: priorPermit.jti,
      authorizationEpoch: 2,
      assignmentEpoch: 7,
    }),
    "active",
    await signPermit(priorPermit),
  );
  return cases;
}
