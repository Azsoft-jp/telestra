// v2 Permitを信頼済みの期待値と照合する。署名成功や期間内の判定は録画実行の許可ではない。
import { validateControl } from "../control-contracts/index.ts";
import type { ControlMap } from "../control-contracts/index.ts";
import { CaptureJwsVerifier, asciiCaptureFields } from "./signature.ts";
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

// 用途と鍵集合は生成時に固定し、別用途のJWSを受け付ける検証器へ変更しない。
export class CapturePermitVerifier {
  readonly #signature: CaptureJwsVerifier<"permit">;
  private constructor(signature: CaptureJwsVerifier<"permit">) {
    this.#signature = signature;
  }
  // 登録済みの専用公開鍵だけを使い、受信URLから鍵を取得しない。
  static async create(
    issuer: string,
    keys: readonly unknown[],
  ): Promise<CapturePermitVerifier> {
    return new CapturePermitVerifier(
      await CaptureJwsVerifier.create("permit", issuer, keys),
    );
  }
  // 期待値は検証済みpolicyから渡す。呼出元の途中変更も検証結果へ混ぜない。
  async verify(
    token: string,
    expected: Context,
  ): Promise<VerifiedCapturePermit> {
    try {
      const context = structuredClone(
        validateControl("CapturePermitV2Context", expected),
      );
      if (!asciiCaptureFields(context)) throw failure();
      const claims = await this.#signature.verify(token);
      if (
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
