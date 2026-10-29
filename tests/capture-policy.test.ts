// 合成policyとPermitを別用途で検証する。署名や鍵をassertionの値へ渡さない。
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, CompactSign } from "jose";
import { CaptureJwsVerifier } from "../packages/capture-permit/signature.ts";
import { CapturePolicyVerifier } from "../packages/capture-permit/policy.ts";
import { CapturePermitVerifier } from "../packages/capture-permit/index.ts";
import { permitClaims, permitContext } from "./fixtures/permit.ts";
import { scenario } from "./evidence.ts";

import { policyClaims } from "./fixtures/policy.ts";

scenario(
  "POLICY-01",
  "signed-policy-binds-permit-without-execution",
  "synthetic-purpose-specific-jws-v2",
  "独立署名のpolicyから期待値を作り、用途・ID・失効・期限を検証しても実行を許可しない",
  async () => {
    const policyKeys = await generateKeyPair("Ed25519"),
      permitKeys = await generateKeyPair("Ed25519");
    const policyKey = {
      ...(await exportJWK(policyKeys.publicKey)),
      alg: "Ed25519",
      kid: "policy-key-01",
    };
    const permitKey = {
      ...(await exportJWK(permitKeys.publicKey)),
      alg: "Ed25519",
      kid: "permit-key-01",
    };
    let purposeDenied = false;
    try {
      await CaptureJwsVerifier.create(
        "toString" as "policy",
        policyClaims.iss,
        [policyKey],
      );
    } catch {
      purposeDenied = true;
    }
    assert.equal(
      purposeDenied,
      true,
      "定義していない用途をprototypeから選ばない",
    );
    const policyVerifier = await CapturePolicyVerifier.create(
      policyClaims.iss,
      [policyKey],
      3600,
    );
    const permitVerifier = await CapturePermitVerifier.create(
      permitClaims.iss,
      [permitKey],
    );
    const signPolicy = (claims: unknown, header = {}) =>
      new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
        .setProtectedHeader({
          alg: "Ed25519",
          typ: "telestra-capture-policy-v2+jwt",
          kid: policyKey.kid,
          ...header,
        })
        .sign(policyKeys.privateKey);
    const permit = await new CompactSign(
      new TextEncoder().encode(JSON.stringify(permitClaims)),
    )
      .setProtectedHeader({
        alg: "Ed25519",
        typ: "telestra-capture-permit-v2+jwt",
        kid: permitKey.kid,
      })
      .sign(permitKeys.privateKey);
    const identity = {
      tenantId: permitClaims.tenantId,
      environment: permitClaims.environment,
      nodeId: permitClaims.nodeId,
      nodeRole: "tuner" as const,
    };
    const policy = await signPolicy(policyClaims);
    const result = await policyVerifier.verifyPermit(
      policy,
      permit,
      permitVerifier,
      identity,
      permitContext.now,
      permitContext.maxObservedTime,
    );
    assert.equal(result.window, "active");
    assert.equal(result.executionAuthorized, false);
    for (const changes of [
      { permitId: "other-permit-id" },
      { revoked: true },
      { authorizationEpoch: 1 },
      { assignmentEpoch: 1 },
      { reservationRevision: 1 },
      { tenantId: "other-household" },
      { exp: permitContext.now },
      { iat: permitContext.now + 1 },
      { maxSpoolBytes: 0 },
    ]) {
      const candidate = await signPolicy({ ...policyClaims, ...changes });
      let denied = false;
      try {
        await policyVerifier.verifyPermit(
          candidate,
          permit,
          permitVerifier,
          identity,
          permitContext.now,
          permitContext.maxObservedTime,
        );
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "policyとPermitの不整合を拒否する");
    }
    for (const header of [
      { typ: "telestra-capture-permit-v2+jwt" },
      { jku: "https://example.invalid/keys" },
      { alg: "EdDSA" },
    ]) {
      const candidate = await signPolicy(policyClaims, header);
      let denied = false;
      try {
        await policyVerifier.verify(
          candidate,
          identity,
          permitContext.now,
          permitContext.maxObservedTime,
        );
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "別用途と未知headerを拒否する");
    }
    const otherIssuer = "https://other.example.invalid";
    const otherVerifier = await CapturePermitVerifier.create(otherIssuer, [
      permitKey,
    ]);
    const foreignPermit = await new CompactSign(
      new TextEncoder().encode(
        JSON.stringify({ ...permitClaims, iss: otherIssuer }),
      ),
    )
      .setProtectedHeader({
        alg: "Ed25519",
        typ: "telestra-capture-permit-v2+jwt",
        kid: permitKey.kid,
      })
      .sign(permitKeys.privateKey);
    assert.equal(
      (await otherVerifier.verify(foreignPermit, permitContext)).window,
      "active",
    );
    let issuerDenied = false;
    try {
      await policyVerifier.verifyPermit(
        policy,
        foreignPermit,
        otherVerifier,
        identity,
        permitContext.now,
        permitContext.maxObservedTime,
      );
    } catch {
      issuerDenied = true;
    }
    assert.equal(
      issuerDenied,
      true,
      "別の信頼済み発行者のPermitでもpolicyへ混ぜない",
    );
    let denied = false;
    try {
      await policyVerifier.verify(
        policy,
        identity,
        permitContext.now,
        permitContext.now + 1,
      );
    } catch {
      denied = true;
    }
    assert.equal(denied, true, "観測済み時刻からの巻き戻りを拒否する");
  },
);
