// 呼出元がメモリで渡した専用鍵だけでpolicyを署名する。秘密値と署名値を保存・表示しない。
import { CompactSign, importJWK } from "jose";
import { validateControl } from "../control-contracts/index.ts";
import type { ControlMap } from "../control-contracts/index.ts";
import { strictJson } from "./json.ts";
import { asciiCaptureFields, CaptureJwsVerifier } from "./signature.ts";

// 鍵の公開部分との一致も署名後に照合し、不整合な鍵から成果物を返さない。
export async function signCapturePolicy(
  claims: ControlMap["CapturePolicyV2"],
  privateJwk: string,
): Promise<string> {
  const value = structuredClone(validateControl("CapturePolicyV2", claims));
  if (!asciiCaptureFields(value))
    throw new Error("録画policyを発行できません。");
  const key = validateControl(
    "CapturePolicySigningKey",
    strictJson(new TextEncoder().encode(privateJwk), 2048),
  );
  if (!asciiCaptureFields(key)) throw new Error("録画policyを発行できません。");
  const { d: _secret, ...publicKey } = key;
  const verifier = await CaptureJwsVerifier.create("policy", value.iss, [
    publicKey,
  ]);
  const token = await new CompactSign(
    new TextEncoder().encode(JSON.stringify(value)),
  )
    .setProtectedHeader({
      alg: "Ed25519",
      typ: "telestra-capture-policy-v2+jwt",
      kid: key.kid,
    })
    .sign(await importJWK(key, "Ed25519"));
  await verifier.verify(token);
  return token;
}
