// originごとのpublic clientでS256とメモリ内資格を扱う。秘密値の永続保存と自動再送は行わない。
import { validateControl } from "../control-contracts/index.ts";
import type { ControlMap } from "../control-contracts/index.ts";
import { verifyIdentity } from "../identity/index.ts";
import { BoundaryError } from "../contracts/error.ts";
import { readResponse } from "./transport.ts";

export type AuthState =
  | "signed-out"
  | "waiting"
  | "authenticated"
  | "expired"
  | "forbidden"
  | "disconnected"
  | "failed"
  | "logout-unconfirmed";
const messages: Readonly<Record<AuthState, string>> = {
  "signed-out": "ログインしていません。",
  waiting: "ログインの完了を待っています。",
  authenticated: "ログインしています。",
  expired: "ログインの期限が切れました。再ログインしてください。",
  forbidden: "この操作を行う権限がありません。",
  disconnected: "接続を確認できません。もう一度操作してください。",
  failed: "ログインを完了できませんでした。もう一度開始してください。",
  "logout-unconfirmed":
    "この画面の認証情報は破棄しました。サーバー側の失効を確認できません。",
};
const failure = () => new BoundaryError("LOGIN_FAILED", messages.failed, 401);
const interrupted = () =>
  new BoundaryError("LOGIN_INTERRUPTED", "ログイン操作を中断しました。", 409);
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));

// RFC 7636のverifierをS256へ変換する。plainへ切り替えるfallbackは設けない。
export async function pkceChallenge(verifier: string): Promise<string> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw failure();
  return encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}
function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw failure();
  return url;
}
// 構成は公開値だけを複製する。IdPから来るURLやredirect先を通信先として再解釈しない。
function configuration(
  value: ControlMap["OidcPublicConfig"],
): ControlMap["OidcPublicConfig"] {
  try {
    const config = structuredClone(validateControl("OidcPublicConfig", value));
    for (const key of [
      "issuer",
      "authorizationEndpoint",
      "tokenEndpoint",
      "redirectUri",
      "appOrigin",
      "apiOrigin",
    ] as const)
      httpsUrl(config[key]);
    if (
      httpsUrl(config.appOrigin).origin !== config.appOrigin ||
      httpsUrl(config.apiOrigin).origin !== config.apiOrigin ||
      httpsUrl(config.redirectUri).origin !== config.appOrigin ||
      config.publicJwks.keys.length === 0
    )
      throw failure();
    return config;
  } catch {
    throw new BoundaryError(
      "INVALID_AUTH_CONFIG",
      "ログイン先の公開設定を確認してください。",
      503,
    );
  }
}

export class BrowserSession {
  #config: ControlMap["OidcPublicConfig"];
  #fetch: typeof fetch;
  #clock: () => number;
  #generation = 0;
  #pending:
    | { verifier: string; state: string; nonce: string; expires: number }
    | undefined;
  #token:
    | { value: string; expires: number; subject: string; tokenExpires: number }
    | undefined;
  #state: AuthState = "signed-out";
  #requests = new Set<AbortController>();

  // 公開構成は検証後に複製する。runtimeのfetchと時刻注入はローカル試験でも使う。
  constructor(
    config: ControlMap["OidcPublicConfig"],
    runtime: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.#config = configuration(config);
    this.#fetch = runtime.fetch ?? globalThis.fetch.bind(globalThis);
    this.#clock = runtime.now ?? (() => Math.floor(Date.now() / 1000));
  }
  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > 9007199254740991)
      throw failure();
    return now;
  }
  #clear(state: AuthState): void {
    this.#generation++;
    this.#pending = undefined;
    this.#token = undefined;
    for (const request of this.#requests) request.abort();
    this.#state = state;
  }
  #expire(): void {
    if (this.#pending && this.#pending.expires <= this.#now())
      this.#clear("expired");
    if (this.#token && this.#token.expires <= this.#now())
      this.#clear("expired");
  }
  async #read(url: string, init: RequestInit) {
    if (this.#requests.size >= 4)
      throw new BoundaryError(
        "AUTH_BUSY",
        "処理中です。完了してからもう一度操作してください。",
        429,
      );
    const controller = new AbortController();
    this.#requests.add(controller);
    try {
      return await readResponse(this.#fetch, url, init, controller);
    } finally {
      this.#requests.delete(controller);
    }
  }
  // 表示用の状態だけを返し、資格・verifier・認可コードを公開しない。
  get snapshot(): Readonly<{
    state: AuthState;
    message: string;
    expiresAt: number | null;
  }> {
    this.#expire();
    return Object.freeze({
      state: this.#state,
      message: messages[this.#state],
      expiresAt: this.#token?.expires ?? null,
    });
  }

  // state・nonce・verifierを一回の開始へ拘束する。再開始・中断は遅れた応答を採用させない。
  async begin(): Promise<string> {
    this.#clear("waiting");
    const generation = this.#generation;
    const verifier = random(),
      state = random(),
      nonce = random();
    const challenge = await pkceChallenge(verifier);
    if (generation !== this.#generation) throw interrupted();
    this.#pending = { verifier, state, nonce, expires: this.#now() + 120 };
    const url = new URL(this.#config.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: this.#config.clientId,
      redirect_uri: this.#config.redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: "openid telestra.api",
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
      nonce,
    }).toString();
    return url.toString();
  }

  // 呼出元は固定callbackから受け取ったURLを渡す。認可応答を使えるのは同じメモリ内の開始だけ。
  // popupを使うUIは、この入口より前にpostMessageのoriginとsourceも完全一致で検証する。
  async complete(callback: string): Promise<void> {
    const pending = this.#pending,
      generation = this.#generation;
    if (!pending) throw failure();
    this.#pending = undefined;
    try {
      if (
        typeof callback !== "string" ||
        new TextEncoder().encode(callback).byteLength > 4096 ||
        pending.expires <= this.#now()
      )
        throw failure();
      const url = new URL(callback);
      if (
        url.origin + url.pathname !== this.#config.redirectUri ||
        url.username ||
        url.password ||
        url.hash
      )
        throw failure();
      const fields = Object.create(null) as Record<string, string>;
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(fields, key)) throw failure();
        fields[key] = value;
      }
      const input = validateControl("OidcCallback", fields);
      if (
        input.state !== pending.state ||
        input.iss !== this.#config.issuer ||
        !/^[\x21-\x7e]+$/.test(input.code)
      )
        throw failure();
      const response = await this.#read(this.#config.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: this.#config.clientId,
          redirect_uri: this.#config.redirectUri,
          code: input.code,
          code_verifier: pending.verifier,
        }).toString(),
      });
      if (generation !== this.#generation) throw interrupted();
      if (response.status !== 200) throw failure();
      const tokens = validateControl("OidcTokenResponse", response.value),
        now = this.#now();
      const id = await verifyIdentity("OidcIdClaims", tokens.id_token, {
        issuer: this.#config.issuer,
        audience: this.#config.clientId,
        typ: "JWT",
        jwks: this.#config.publicJwks,
        now,
        maxLifetime: 900,
      });
      const access = await verifyIdentity("UserClaims", tokens.access_token, {
        issuer: this.#config.issuer,
        audience: this.#config.apiAudience,
        typ: "at+jwt",
        jwks: this.#config.publicJwks,
        now,
        maxLifetime: 900,
      });
      if (id.nonce !== pending.nonce || id.sub !== access.sub) throw failure();
      if (generation !== this.#generation) throw interrupted();
      const session = await this.#api(
        "/session",
        "GET",
        undefined,
        tokens.access_token,
      );
      if (generation !== this.#generation) throw interrupted();
      if (session.status !== 200) throw failure();
      const user = validateControl("ApiSession", session.value);
      if (user.subject !== access.sub || user.expiresAt !== access.exp)
        throw failure();
      const expires = Math.min(access.exp, id.exp, now + tokens.expires_in);
      if (expires <= this.#now()) throw failure();
      this.#token = {
        value: tokens.access_token,
        expires,
        tokenExpires: access.exp,
        subject: access.sub,
      };
      this.#state = "authenticated";
    } catch {
      if (generation === this.#generation) this.#clear("failed");
      throw failure();
    }
  }

  async #api(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    token: string,
  ) {
    // 相対パスの限定操作だけを受け付ける。Bearerを任意URLやredirectへ転送しない。
    if (method !== "GET" && method !== "POST") throw failure();
    if (
      !/^\/(?:session|sessions\/revoke|reservations(?:\/[A-Za-z0-9_.:-]{3,128})?|recordings\/[A-Za-z0-9_.:-]{3,128}|nodes(?:\/challenges|\/[A-Za-z0-9_.:-]{3,128}\/(?:revoke|commands|connection))?)$/.test(
        path,
      )
    )
      throw new BoundaryError(
        "INVALID_OPERATION",
        "この操作は利用できません。",
        400,
      );
    let raw: string | undefined;
    if (body !== undefined) {
      try {
        raw = JSON.stringify(body);
      } catch {
        throw failure();
      }
      if (
        method !== "POST" ||
        raw === undefined ||
        new TextEncoder().encode(raw).byteLength > 8192
      )
        throw failure();
    }
    return this.#read(this.#config.apiOrigin + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(raw !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(raw !== undefined ? { body: raw } : {}),
    });
  }

  // 認可は毎回API側の台帳で行う。401では資格を破棄し、403と通信断は状態を区別して表示する。
  async request(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<unknown> {
    this.#expire();
    const token = this.#token,
      generation = this.#generation;
    if (!token) throw failure();
    try {
      const response = await this.#api(
        path,
        options.method ?? "GET",
        options.body,
        token.value,
      );
      if (generation !== this.#generation) throw interrupted();
      if (response.status === 401) {
        this.#clear("expired");
        throw failure();
      }
      if (response.status === 403) {
        this.#state = "forbidden";
        throw new BoundaryError("FORBIDDEN", messages.forbidden, 403);
      }
      if (response.status < 200 || response.status >= 300)
        throw new BoundaryError(
          "API_FAILED",
          "操作を完了できませんでした。",
          response.status,
        );
      this.#state = "authenticated";
      return response.value;
    } catch (error) {
      if (
        generation === this.#generation &&
        error instanceof BoundaryError &&
        error.code === "AUTH_NETWORK"
      )
        this.#state = "disconnected";
      throw error instanceof BoundaryError ? error : failure();
    }
  }
  // APIの現在値を取得する。保存済みのRoleを認可根拠にせず、主体と期限も再照合する。
  async session(): Promise<ControlMap["ApiSession"]> {
    const generation = this.#generation;
    // 通信断やHTTPの拒否はrequestの状態を保つ。成功応答の構造・主体不整合は資格を破棄する。
    const raw = await this.request("/session");
    if (generation !== this.#generation) throw interrupted();
    try {
      const result = validateControl("ApiSession", raw);
      if (
        !this.#token ||
        result.subject !== this.#token.subject ||
        result.expiresAt !== this.#token.tokenExpires
      )
        throw failure();
      return result;
    } catch {
      this.#clear("failed");
      throw failure();
    }
  }
  // 失効要求は一回だけ送る。応答を確認できなくてもローカルの資格は破棄し、未確認を表示する。
  async logout(): Promise<void> {
    const token = this.#token;
    this.#clear("signed-out");
    const generation = this.#generation;
    if (!token) return;
    try {
      const response = await this.#api(
        "/sessions/revoke",
        "POST",
        {},
        token.value,
      );
      if (
        response.status !== 200 ||
        typeof response.value !== "object" ||
        response.value === null ||
        !("state" in response.value) ||
        response.value.state !== "revoked"
      )
        throw failure();
    } catch {
      if (generation === this.#generation) this.#state = "logout-unconfirmed";
      throw new BoundaryError(
        "LOGOUT_UNCONFIRMED",
        messages["logout-unconfirmed"],
        503,
      );
    }
  }
  // 画面の破棄・認可操作の中断用。サーバー失効の完了とは扱わない。
  cancel(): void {
    this.#clear("signed-out");
  }
}
