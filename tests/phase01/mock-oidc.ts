// 合成IdPで認可コードとS256を照合し、取得した資格で実際のローカルWorkerを呼ぶ。
// HTTPは注入したfetch内で完結し、コード・鍵・資格をログやファイルへ保存しない。
import { createHash, randomBytes } from "node:crypto";
import type { Fixture } from "./helper.ts";
import { origin } from "./helper.ts";
import { publicKeys } from "../../packages/identity/index.ts";
import type { ControlMap } from "../../packages/control-contracts/index.ts";

export function mockOidc(context: Fixture, appOrigin = origin) {
  const issuer = context.bindings.TELESTRA_OIDC_ISSUER;
  const config: ControlMap["OidcPublicConfig"] = {
    issuer,
    clientId: "telestra-browser-local",
    apiAudience: context.bindings.TELESTRA_OIDC_AUDIENCE,
    authorizationEndpoint: issuer + "/authorize",
    tokenEndpoint: issuer + "/token",
    appOrigin,
    apiOrigin: "https://api.example.test",
    redirectUri: appOrigin + "/auth/callback",
    publicJwks: publicKeys(
      context.bindings.TELESTRA_OIDC_JWKS,
    ) as ControlMap["OidcPublicConfig"]["publicJwks"],
  };
  const codes = new Map<
    string,
    { challenge: string; nonce: string; subject: string; expires: number }
  >();
  let tokenRequests = 0,
    apiRequests = 0,
    lastAccessToken = "";
  const authorize = (authorizationUrl: string, subject = "viewer-local") => {
    const url = new URL(authorizationUrl),
      p = url.searchParams;
    if (
      url.origin + url.pathname !== config.authorizationEndpoint ||
      p.get("client_id") !== config.clientId ||
      p.get("redirect_uri") !== config.redirectUri ||
      p.get("response_type") !== "code" ||
      p.get("scope") !== "openid telestra.api" ||
      p.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.get("state") ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.get("nonce") ?? "") ||
      codes.size >= 32
    )
      throw new Error("Mock IdPへの認可要求が不正です。");
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      challenge: p.get("code_challenge")!,
      nonce: p.get("nonce")!,
      subject,
      expires: context.now() + 120,
    });
    const callback = new URL(config.redirectUri);
    callback.search = new URLSearchParams({
      code,
      state: p.get("state")!,
      iss: issuer,
    }).toString();
    return callback.toString();
  };
  const perform: typeof fetch = async (input, options) => {
    const request = new Request(input, options),
      url = new URL(request.url);
    if (
      options?.credentials !== "omit" ||
      options.redirect !== "error" ||
      options.cache !== "no-store"
    )
      throw new Error("Cookieまたはキャッシュの設定が不正です。");
    if (url.href === config.tokenEndpoint && request.method === "POST") {
      tokenRequests++;
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 8192)
        return new Response(null, { status: 413 });
      const p = new URLSearchParams(raw),
        code = p.get("code") ?? "",
        grant = codes.get(code);
      codes.delete(code);
      if (
        !grant ||
        grant.expires <= context.now() ||
        p.get("grant_type") !== "authorization_code" ||
        p.get("client_id") !== config.clientId ||
        p.get("redirect_uri") !== config.redirectUri ||
        createHash("sha256")
          .update(p.get("code_verifier") ?? "")
          .digest("base64url") !== grant.challenge
      )
        return new Response(null, { status: 400 });
      lastAccessToken = await context.mint(grant.subject);
      return Response.json(
        {
          access_token: lastAccessToken,
          id_token: await context.mintIdToken(grant.subject, grant.nonce),
          token_type: "Bearer",
          expires_in: 600,
          scope: "openid telestra.api",
        },
        {
          headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
        },
      );
    }
    if (url.origin === config.apiOrigin && !url.search && !url.hash) {
      apiRequests++;
      const headers = Object.fromEntries(request.headers);
      // Browserが付けるOriginを再現する。実IdP・インターネットへは転送しない。
      headers.Origin = appOrigin;
      const response = await context.mf.dispatchFetch(
        "http://localhost" + url.pathname,
        {
          method: request.method,
          headers,
          ...(request.method === "POST" ? { body: await request.text() } : {}),
        },
      );
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    }
    throw new Error("Mockに登録していない通信です。");
  };
  return {
    config,
    authorize,
    fetch: perform,
    get tokenRequests() {
      return tokenRequests;
    },
    get apiRequests() {
      return apiRequests;
    },
    // 失効の確認に限り、合成IdP自身が発行した資格をメモリ内で参照する。
    get issuedToken() {
      return lastAccessToken;
    },
  };
}
