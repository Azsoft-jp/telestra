// 署名済みpolicyをPermitとは別用途で検証し、未署名の期待値を補完しない。
import type { ControlMap } from "../control-contracts/index.ts";
import { CaptureJwsVerifier } from "./signature.ts";
import type { CapturePermitVerifier, VerifiedCapturePermit } from "./index.ts";
type Claims = ControlMap["CapturePolicyV2"];
export interface PolicyIdentity {
  tenantId: string;
  environment: string;
  nodeId: string;
  nodeRole: "tuner";
}
export interface VerifiedCapturePolicy {
  readonly claims: Readonly<Claims>;
  readonly executionAuthorized: false;
}
const failure = (): Error =>
  new Error("録画policyの署名・対象・有効期間を確認してください。");
export class CapturePolicyVerifier {
  readonly #signature: CaptureJwsVerifier<"policy">;
  readonly #maxLifetime: number;
  private constructor(
    signature: CaptureJwsVerifier<"policy">,
    maxLifetime: number,
  ) {
    this.#signature = signature;
    this.#maxLifetime = maxLifetime;
  }
  // policy専用の鍵と許可期間上限を、信頼済みの構成から必ず指定する。既定TTLは作らない。
  static async create(
    issuer: string,
    keys: readonly unknown[],
    maxLifetime: number,
  ): Promise<CapturePolicyVerifier> {
    if (!Number.isSafeInteger(maxLifetime) || maxLifetime < 1) throw failure();
    return new CapturePolicyVerifier(
      await CaptureJwsVerifier.create("policy", issuer, keys),
      maxLifetime,
    );
  }
  // 現在時刻と観測済み時刻はNode側の根拠から渡し、policy中のiatを時計として使わない。
  async verify(
    token: string,
    identity: PolicyIdentity,
    now: number,
    maxObservedTime: number,
  ): Promise<VerifiedCapturePolicy> {
    try {
      const expected = { ...identity };
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !Number.isSafeInteger(maxObservedTime) ||
        maxObservedTime < 0 ||
        now < maxObservedTime
      )
        throw failure();
      const claims = await this.#signature.verify(token);
      if (
        claims.sub !== expected.nodeId ||
        claims.nodeId !== expected.nodeId ||
        claims.tenantId !== expected.tenantId ||
        claims.environment !== expected.environment ||
        expected.nodeRole !== "tuner" ||
        claims.iat > now ||
        claims.exp <= now ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > this.#maxLifetime ||
        claims.captureLatest <= claims.captureEarliest ||
        claims.maxPermitLifetime < 1 ||
        claims.maxOfflineSeconds > claims.maxPermitLifetime
      )
        throw failure();
      return Object.freeze({
        claims: Object.freeze(claims),
        executionAuthorized: false,
      });
    } catch {
      throw failure();
    }
  }
  // 二つの署名を検証してから期待値を組み立て、ID・世代・期限が一致するPermitだけを返す。
  async verifyPermit(
    policyToken: string,
    permitToken: string,
    permitVerifier: CapturePermitVerifier,
    identity: PolicyIdentity,
    now: number,
    maxObservedTime: number,
  ): Promise<VerifiedCapturePermit> {
    const { claims: policy } = await this.verify(
      policyToken,
      identity,
      now,
      maxObservedTime,
    );
    if (policy.revoked) throw failure();
    const {
      schemaVersion: _version,
      iss: _issuer,
      aud: _audience,
      sub: _subject,
      jti: _id,
      iat: _issued,
      exp: _expires,
      permitId: _permitId,
      ...bounds
    } = policy;
    const verified = await permitVerifier.verify(permitToken, {
      ...bounds,
      revoked: false,
      anchorKnown: true,
      now,
      maxObservedTime,
    });
    if (
      verified.claims.iss !== policy.iss ||
      verified.claims.jti !== policy.permitId ||
      verified.claims.exp > policy.exp
    )
      throw failure();
    return verified;
  }
}
