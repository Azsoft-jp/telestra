// 合成鍵だけでv2署名と用途・時刻・世代を検証する。資格や署名済み本文を失敗ログへ出さない。
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, CompactSign } from "jose";
import { CapturePermitVerifier } from "../packages/capture-permit/index.ts";
import { scenario } from "./evidence.ts";
import { permitClaims, permitContext } from "./fixtures/permit.ts";

scenario(
  "PERMIT-01",
  "v2-signature-binding-and-time",
  "synthetic-ed25519-v2",
  "未来の許可は待機し、改変・旧世代・期限切れを拒否する",
  async () => {
    const keys = await generateKeyPair("Ed25519");
    const jwk = {
      ...(await exportJWK(keys.publicKey)),
      alg: "Ed25519",
      kid: "permit-key-01",
    };
    const verifier = await CapturePermitVerifier.create(permitClaims.iss, [
      jwk,
    ]);
    const sign = async (value: unknown, header: Record<string, unknown> = {}) =>
      new CompactSign(new TextEncoder().encode(JSON.stringify(value)))
        .setProtectedHeader({
          alg: "Ed25519",
          typ: "telestra-capture-permit-v2+jwt",
          kid: jwk.kid,
          ...header,
        })
        .sign(keys.privateKey);
    const token = await sign(permitClaims);
    const result = await verifier.verify(token, permitContext);
    assert.equal(result.window, "active");
    assert.equal(result.executionAuthorized, false);
    assert.equal(
      (
        await verifier.verify(
          await sign({ ...permitClaims, nbf: permitContext.now + 10 }),
          permitContext,
        )
      ).window,
      "waiting",
    );
    for (const change of [
      { authorizationEpoch: 2 },
      { assignmentEpoch: 7 },
      { tenantId: "other-household" },
      { sub: "other-node" },
      { captureScope: "multiplex" },
      { exp: permitContext.now },
      { iat: permitContext.now + 1 },
      { spoolMaxBytes: permitContext.maxSpoolBytes + 1 },
    ]) {
      const bad = await sign({ ...permitClaims, ...change });
      let denied = false;
      try {
        await verifier.verify(bad, permitContext);
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "v2の境界違反を拒否する");
    }
    for (const header of [
      { typ: "tv-node+jwt" },
      { jku: "https://example.invalid/keys" },
      { alg: "EdDSA" },
    ]) {
      const bad = await sign(permitClaims, header);
      let denied = false;
      try {
        await verifier.verify(bad, permitContext);
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "他用途や拡張headerを拒否する");
    }
  },
);

scenario(
  "PERMIT-03",
  "purpose-key-set-and-config-denials",
  "synthetic-pinned-public-keys",
  "不正な鍵集合を拒否し、構成差替えを既存検証器へ混入させない",
  async () => {
    const pair = await generateKeyPair("Ed25519");
    const key = {
      ...(await exportJWK(pair.publicKey)),
      alg: "Ed25519",
      kid: "permit-config-01",
    };
    for (const keys of [
      [],
      Array(9).fill(key),
      [key, key],
      [{ ...key, alg: "EdDSA" }],
      [{ ...key, crv: "X25519" }],
      [{ ...key, x: "A" }],
      [{ ...key, use: "sig" }],
      [{ ...key, kid: key.kid + "\n" }],
      [{ ...key, d: "invalid-fixture-value" }],
    ]) {
      let denied = false;
      try {
        await CapturePermitVerifier.create(permitClaims.iss, keys);
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "不正な鍵構成を拒否する");
    }
    for (const issuer of [
      "https://example.invalid\n",
      "http://example.invalid",
      "https://user@example.invalid",
      "https://example.invalid?keys=1",
      "https://example.invalid/#fragment",
    ]) {
      let denied = false;
      try {
        await CapturePermitVerifier.create(issuer, [key]);
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "許可外の発行者を拒否する");
    }
    const verifier = await CapturePermitVerifier.create(permitClaims.iss, [
      key,
    ]);
    const token = await new CompactSign(
      new TextEncoder().encode(JSON.stringify(permitClaims)),
    )
      .setProtectedHeader({
        alg: "Ed25519",
        typ: "telestra-capture-permit-v2+jwt",
        kid: key.kid,
      })
      .sign(pair.privateKey);
    const other = await generateKeyPair("Ed25519");
    const replacement = (await exportJWK(other.publicKey)).x;
    if (typeof replacement !== "string")
      throw new Error("合成公開鍵がありません。");
    key.x = replacement;
    assert.equal(
      (await verifier.verify(token, permitContext)).window,
      "active",
    );
    const replaced = await CapturePermitVerifier.create(permitClaims.iss, [
      key,
    ]);
    let denied = false;
    try {
      await replaced.verify(token, permitContext);
    } catch {
      denied = true;
    }
    assert.equal(denied, true, "明示した鍵差替え後は旧署名を拒否する");
    // 非同期検証の途中で呼出元が期待値を変更しても、検証開始時の複製を使う。
    const context = { ...permitContext };
    const pending = verifier.verify(token, context);
    context.authorizationEpoch++;
    assert.equal((await pending).window, "active");
  },
);
