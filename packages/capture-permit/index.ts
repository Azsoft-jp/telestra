// v2の署名と信頼済みpolicyの拘束を検証する。policyの取得・永続化や録画開始は行わない。
import { validateControl } from "../control-contracts/index.ts";
import type { ControlMap } from "../control-contracts/index.ts";
import { strictJson } from "./json.ts";

type Context = ControlMap["CapturePermitV2Context"];
type Claims = ControlMap["CapturePermitV2"];
export interface VerifiedCapturePermit {
  readonly claims: Readonly<Claims>;
  readonly window: "waiting" | "active";
  readonly executionAuthorized: false;
}
const bindings = [
  "tenantId",
  "environment",
  "nodeId",
  "nodeRole",
  "authorizationEpoch",
  "assignmentEpoch",
  "reservationId",
  "reservationRevision",
  "recordingId",
  "attemptId",
  "backendId",
  "serviceKey",
  "captureScope",
  "storageScopeId",
] as const;
const failure = (): Error =>
  new Error("録画許可の署名・対象・有効期間を確認してください。");

// 全string項目は固定用途名かASCII識別子。JavaScriptの$が末尾改行を許す差もここで拒否する。
function asciiFields(value: object): boolean {
  return Object.values(value).every(
    (item) => typeof item !== "string" || !/[^\x21-\x7e]/.test(item),
  );
}

// 余分なpaddingや未使用bitの差も拒否し、両言語で同じCompact JWS表現だけを扱う。
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

// インスタンス生成後に呼出元が鍵を変更しても、検証に使う固定鍵集合は変わらない。
export class CapturePermitVerifier {
  readonly #issuer: string;
  readonly #keys: ReadonlyMap<string, CryptoKey>;
  private constructor(issuer: string, keys: Map<string, CryptoKey>) {
    this.#issuer = issuer;
    this.#keys = keys;
  }

  // HTTPSの固定発行者と専用公開鍵を1〜8本だけ受け付け、URLによる鍵探索を持たない。
  static async create(
    issuer: string,
    keys: readonly unknown[],
  ): Promise<CapturePermitVerifier> {
    try {
      if (
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
      const pinned = new Map<string, CryptoKey>();
      // 非同期の鍵importより先に設定を複製し、途中変更による鍵の差替えを防ぐ。
      const copies = keys.map((key) => {
        const validated = validateControl("CapturePermitV2Key", key);
        if (!asciiFields(validated)) throw failure();
        return structuredClone(validated);
      });
      for (const key of copies) {
        if (pinned.has(key.kid)) throw failure();
        const raw = decode(key.x);
        if (raw.byteLength !== 32) throw failure();
        pinned.set(
          key.kid,
          await crypto.subtle.importKey("raw", raw, "Ed25519", false, [
            "verify",
          ]),
        );
      }
      return new CapturePermitVerifier(issuer, pinned);
    } catch {
      throw failure();
    }
  }

  // 期待値は検証済みpolicyから渡す。署名成功もactive判定も、実行権限として返さない。
  async verify(
    token: string,
    expected: Context,
  ): Promise<VerifiedCapturePermit> {
    try {
      const context = structuredClone(
        validateControl("CapturePermitV2Context", expected),
      );
      if (
        !asciiFields(context) ||
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
      const header = validateControl(
        "CapturePermitV2Header",
        strictJson(decode(head), 1024),
      );
      const key = this.#keys.get(header.kid);
      const sig = decode(signature);
      // 受信した署名対象バイト列をそのまま使い、JSONを組み直して照合しない。
      if (
        !asciiFields(header) ||
        !key ||
        sig.byteLength !== 64 ||
        !(await crypto.subtle.verify(
          "Ed25519",
          key,
          sig,
          new TextEncoder().encode(`${head}.${body}`),
        ))
      )
        throw failure();
      const claims = validateControl(
        "CapturePermitV2",
        strictJson(decode(body), 8192),
      );
      if (
        !asciiFields(claims) ||
        claims.iss !== this.#issuer ||
        claims.sub !== context.nodeId ||
        bindings.some((name) => claims[name] !== context[name]) ||
        context.now < context.maxObservedTime ||
        context.captureLatest <= context.captureEarliest ||
        context.maxPermitLifetime < 1 ||
        claims.iat > context.now ||
        claims.iat > claims.nbf ||
        claims.nbf >= claims.exp ||
        claims.exp <= context.now ||
        claims.nbf < context.captureEarliest ||
        claims.exp > context.captureLatest ||
        claims.exp - claims.iat > context.maxPermitLifetime ||
        claims.offlineAllowedUntil < claims.nbf ||
        claims.offlineAllowedUntil > claims.exp ||
        claims.offlineAllowedUntil - claims.iat > context.maxOfflineSeconds ||
        claims.spoolMaxBytes > context.maxSpoolBytes
      )
        throw failure();
      return Object.freeze({
        claims: Object.freeze(claims),
        window: context.now < claims.nbf ? "waiting" : "active",
        executionAuthorized: false,
      });
    } catch {
      throw failure();
    }
  }
}
