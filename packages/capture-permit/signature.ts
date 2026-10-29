// v2の署名部分だけを共用する。用途ごとの固定header・claims・鍵集合を混ぜない。
import { validateControl } from "../control-contracts/index.ts";
import type { ControlMap } from "../control-contracts/index.ts";
import { strictJson } from "./json.ts";
const profiles = {
  permit: { header: "CapturePermitV2Header", claims: "CapturePermitV2" },
  policy: { header: "CapturePolicyV2Header", claims: "CapturePolicyV2" },
} as const;
type Purpose = keyof typeof profiles;
type Claims<P extends Purpose> = ControlMap[(typeof profiles)[P]["claims"]];
const failure = (): Error =>
  new Error("録画許可の署名・対象・有効期間を確認してください。");

// 固定用途名と識別子はASCIIに限定し、末尾改行に対する正規表現の言語差も拒否する。
export function asciiCaptureFields(value: object): boolean {
  return Object.values(value).every(
    (item) => typeof item !== "string" || !/[^\x21-\x7e]/.test(item),
  );
}
// paddingと未使用bitの差を拒否し、JWSの同じ表現だけを両言語で受け付ける。
function decode(raw: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw failure();
  const bytes = Uint8Array.from(
    atob(raw.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const canonical = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (raw !== canonical) throw failure();
  return bytes;
}
export class CaptureJwsVerifier<P extends Purpose> {
  readonly #purpose: P;
  readonly #issuer: string;
  readonly #keys: ReadonlyMap<string, CryptoKey>;
  private constructor(
    purpose: P,
    issuer: string,
    keys: Map<string, CryptoKey>,
  ) {
    this.#purpose = purpose;
    this.#issuer = issuer;
    this.#keys = keys;
  }
  // 設定を非同期処理前に複製し、HTTPSの固定発行者と1〜8本の公開鍵を保持する。
  static async create<P extends Purpose>(
    purpose: P,
    issuer: string,
    keys: readonly unknown[],
  ): Promise<CaptureJwsVerifier<P>> {
    try {
      if (
        !Object.hasOwn(profiles, purpose) ||
        typeof issuer !== "string" ||
        /[^\x21-\x7e]/.test(issuer) ||
        issuer.length > 512 ||
        !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/.test(
          issuer,
        ) ||
        !Array.isArray(keys) ||
        keys.length < 1 ||
        keys.length > 8
      )
        throw failure();
      const copies = keys.map((key) => {
        const value = validateControl("CapturePermitV2Key", key);
        if (!asciiCaptureFields(value)) throw failure();
        return structuredClone(value);
      });
      const pinned = new Map<string, CryptoKey>();
      for (const key of copies) {
        if (pinned.has(key.kid)) throw failure();
        const raw = decode(key.x);
        if (raw.length !== 32) throw failure();
        pinned.set(
          key.kid,
          await crypto.subtle.importKey("raw", raw, "Ed25519", false, [
            "verify",
          ]),
        );
      }
      return new CaptureJwsVerifier(purpose, issuer, pinned);
    } catch {
      throw failure();
    }
  }
  // 受信した署名対象バイト列を直接検証し、再シリアライズ・動的鍵取得・alg切替を行わない。
  async verify(token: string): Promise<Claims<P>> {
    try {
      if (
        typeof token !== "string" ||
        token.length > 8192 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw failure();
      const [head, body, signature] = token.split(".") as [
        string,
        string,
        string,
      ];
      const profile = profiles[this.#purpose];
      const header = validateControl(
        profile.header,
        strictJson(decode(head), 1024),
      );
      const key = this.#keys.get(header.kid),
        sig = decode(signature);
      if (
        !asciiCaptureFields(header) ||
        !key ||
        sig.length !== 64 ||
        !(await crypto.subtle.verify(
          "Ed25519",
          key,
          sig,
          new TextEncoder().encode(`${head}.${body}`),
        ))
      )
        throw failure();
      const claims = validateControl(
        profile.claims,
        strictJson(decode(body), 8192),
      );
      if (!asciiCaptureFields(claims) || claims.iss !== this.#issuer)
        throw failure();
      return claims as Claims<P>;
    } catch {
      throw failure();
    }
  }
}
