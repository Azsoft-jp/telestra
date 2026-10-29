// Tokenの用途・署名・期限を照合し、登録済みの公開鍵だけで主体を検証する。
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  SignJWT,
} from "jose";
import type { JWK } from "jose";
import { validateControl } from "../control-contracts/index.ts";
import type { ControlMap } from "../control-contracts/index.ts";
import { BoundaryError } from "../contracts/error.ts";

export type IdentityKind =
  | "UserClaims"
  | "NodeClaims"
  | "DeviceProof"
  | "ControlClaims"
  | "OidcIdClaims";
// 認証失敗の詳細を外部へ出さず、共通の応答へ変換する。
export function authFailure(): BoundaryError {
  return new BoundaryError("UNAUTHORIZED", "認証情報を確認してください。", 401);
}
// 設定や台帳のJSONにもサイズ上限を適用し、構造の検証は呼出元で行う。
export function parseJson(raw: string, limit = 16_384): unknown {
  if (new TextEncoder().encode(raw).byteLength > limit)
    throw new BoundaryError("TOO_LARGE", "データが上限を超えています。", 413);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BoundaryError("INVALID_JSON", "データの形式を確認してください。");
  }
}
// 参加コードや監査主体を、平文保存を避けるためのSHA-256値へ変換する。
export async function digest(raw: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
// 設定された公開鍵を最大8本に制限し、秘密鍵や別方式の鍵を拒否する。
export function publicKeys(raw: string): { keys: JWK[] } {
  const value = parseJson(raw) as { keys?: unknown };
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > 8
  )
    throw authFailure();
  return { keys: value.keys.map((key) => validateControl("PublicJwk", key)) };
}
export async function verifyIdentity<K extends IdentityKind>(
  kind: K,
  token: string,
  options: {
    issuer: string;
    audience: string;
    typ: string;
    jwks: { keys: JWK[] };
    now: number;
    maxLifetime: number;
  },
): Promise<ControlMap[K]> {
  // 設定済みの公開鍵と用途を照合する。Token内のURLを取得して鍵を探してはいけない。
  try {
    if (
      typeof token !== "string" ||
      token.length > (kind === "ControlClaims" ? 16_384 : 8192) ||
      !Number.isSafeInteger(options.now)
    )
      throw authFailure();
    const header = decodeProtectedHeader(token);
    if (
      header.alg !== "EdDSA" ||
      typeof header.kid !== "string" ||
      !/^[A-Za-z0-9_.:-]{3,128}$/.test(header.kid) ||
      Object.keys(header).some((key) => !["alg", "kid", "typ"].includes(key))
    )
      throw authFailure();
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet(options.jwks),
      {
        issuer: options.issuer,
        audience: options.audience,
        typ: options.typ,
        algorithms: ["EdDSA"],
        currentDate: new Date(options.now * 1000),
        clockTolerance: 0,
        // ID Tokenのnonceは認可開始時の値と別途照合する。標準で任意のjtiを必須にしない。
        requiredClaims:
          kind === "OidcIdClaims"
            ? ["iat", "exp", "sub", "nonce"]
            : ["iat", "exp", "jti", "sub"],
      },
    );
    const claims = validateControl(kind, payload);
    if (
      claims.iat > options.now ||
      claims.exp <= options.now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > options.maxLifetime
    )
      throw authFailure();
    return claims;
  } catch {
    throw authFailure();
  }
}
export async function signCredential(
  claims: ControlMap["NodeClaims"],
  privateJwk: string,
): Promise<string> {
  // 秘密鍵は呼出元の環境から受け取り、値や署名対象を例外メッセージへ含めない。
  return signClaims("NodeClaims", claims, privateJwk, "tv-node+jwt");
}

// 制御本文も資格と異なる用途で署名し、認証Tokenとして転用させない。
export async function signControl(
  claims: ControlMap["ControlClaims"],
  privateJwk: string,
): Promise<string> {
  return signClaims("ControlClaims", claims, privateJwk, "tv-control+jwt");
}

// 鍵の解釈と署名失敗の応答を共通化し、秘密値を例外へ含めない。
async function signClaims<K extends "NodeClaims" | "ControlClaims">(
  kind: K,
  claims: ControlMap[K],
  privateJwk: string,
  typ: string,
): Promise<string> {
  validateControl(kind, claims);
  try {
    const key = parseJson(privateJwk, 2048) as JWK;
    if (
      key.kty !== "OKP" ||
      key.crv !== "Ed25519" ||
      typeof key.d !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key.d) ||
      typeof key.kid !== "string"
    )
      throw authFailure();
    return await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ })
      .sign(await importJWK(key, "EdDSA"));
  } catch {
    throw new BoundaryError(
      "SIGNER_UNAVAILABLE",
      "資格情報を発行できません。管理者に確認してください。",
      503,
    );
  }
}
export function bearer(header: string | null): string {
  // Cookieやクエリを資格として扱わず、長さを制限したBearer形式だけを受け付ける。
  if (
    header === null ||
    header.length > 8192 ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)
  )
    throw authFailure();
  return header.slice(7);
}
