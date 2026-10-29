// 4つのloopback TLS originで認証を再現する。固定経路だけを扱い、本番構成や秘密値をログへ出さない。
import { createServer } from "node:https";
import { createServer as httpServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { fixture } from "../phase01/helper.ts";
import { mockOidc } from "../phase01/mock-oidc.ts";

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error("入力の形式が不正です。");
    length += chunk.length;
    if (length > 8192) throw new Error("入力の上限を超えました。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(new Error("TLS fixtureを起動できません。")),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        reject(new Error("試験用ポートを確認できません。"));
      else resolve(`https://127.0.0.1:${address.port}`);
    });
  });
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) =>
      error ? reject(new Error("TLS fixtureを終了できません。")) : resolve(),
    ),
  );
}

export async function authFixture(tls: { certificate: string; key: string }) {
  let dispatch:
    | ((
        index: number,
        request: IncomingMessage,
        response: ServerResponse,
      ) => Promise<void>)
    | undefined;
  const servers = Array.from({ length: 4 }, (_, index) =>
    createServer(
      {
        cert: tls.certificate,
        key: tls.key,
        maxHeaderSize: 8192,
        requestTimeout: 5000,
        headersTimeout: 5000,
      },
      (request, response) => {
        if (!dispatch) {
          response.writeHead(503);
          response.end();
          return;
        }
        void dispatch(index, request, response).catch(() => {
          if (!response.headersSent)
            response.writeHead(400, { "Cache-Control": "no-store" });
          response.end("試験用の要求を確認できません。");
        });
      },
    ),
  );
  const bound = await Promise.allSettled(servers.map(listen));
  if (bound.some((r) => r.status === "rejected")) {
    await Promise.all(servers.map(close));
    throw new Error("認証fixtureを起動できません。");
  }
  const origins = bound.map((r) => (r.status === "fulfilled" ? r.value : ""));
  const app = origins[0]!,
    secondary = origins[1]!,
    idp = origins[2]!,
    api = origins[3]!;
  // 通常のCORS処理を横取りせず、loopback以外の通信を転送しないproxyで遮断する。
  const denyProxy = httpServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    (_request, response) => {
      response.writeHead(403, { Connection: "close" });
      response.end();
    },
  );
  denyProxy.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  let proxy: string;
  try {
    proxy = (await listen(denyProxy)).replace("https:", "http:");
  } catch {
    await Promise.all(servers.map(close));
    throw new Error("遮断用proxyを起動できません。");
  }
  const allServers = [...servers, denyProxy];
  const context = await fixture(undefined, [app, secondary]).catch(async () => {
    await Promise.all(allServers.map(close));
    throw new Error("ローカルWorkerを起動できません。");
  });
  const stats = { apiRequests: 0, preflights: 0 };
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await Promise.all(allServers.map(close));
    } finally {
      await context.close();
    }
  };
  try {
    const providers = [app, secondary].map((origin) => {
      const provider = mockOidc(context, origin);
      provider.config.authorizationEndpoint = idp + "/authorize";
      provider.config.tokenEndpoint = idp + "/token";
      provider.config.apiOrigin = api;
      return provider;
    });
    const assets = new Map<
      string,
      { type: string; data: Uint8Array | string }
    >();
    for (const [path, file, type] of [
      ["/", "apps/web/auth-fixture/index.html", "text/html"],
      ["/auth/callback", "apps/web/auth-fixture/callback.html", "text/html"],
      ["/demo.css", "apps/web/demo/demo.css", "text/css"],
      ["/auth.css", "apps/web/auth-fixture/auth.css", "text/css"],
      [
        "/fundamental-button.css",
        "node_modules/fundamental-styles/dist/button.css",
        "text/css",
      ],
      ["/logo.svg", "assets/brand/logo.svg", "image/svg+xml"],
      ["/favicon.svg", "assets/brand/icon.svg", "image/svg+xml"],
    ] as const)
      assets.set(path, { type, data: await readFile(file) });
    for (const [path, entry] of [
      ["/auth.mjs", "apps/web/auth-fixture/main.ts"],
      ["/callback.mjs", "apps/web/auth-fixture/callback.ts"],
    ] as const) {
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2023",
        sourcemap: false,
        minify: false,
      });
      assets.set(path, {
        type: "text/javascript",
        data: result.outputFiles[0]!.contents,
      });
    }
    dispatch = async (index, request, response) => {
      const own = origins[index]!;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader(
        "Cross-Origin-Opener-Policy",
        index < 2 ? "same-origin-allow-popups" : "unsafe-none",
      );
      response.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
      );
      response.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${idp} ${api} 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      );
      const reject = (status: number) => {
        response.writeHead(status, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("このfixture操作は利用できません。");
      };
      if (
        request.headers.host !== new URL(own).host ||
        Buffer.byteLength(request.url ?? "") > 4096
      )
        return reject(403);
      const url = new URL(request.url ?? "/", own);
      // callbackはopenerとの通信専用ページとし、親のCOOPとは分けて検証する。
      if (index < 2 && url.pathname === "/auth/callback")
        response.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
      if (url.origin !== own || url.username || url.password || url.hash)
        return reject(403);
      if (
        request.method === "GET" &&
        (request.headers["transfer-encoding"] ||
          Number(request.headers["content-length"] ?? 0) !== 0)
      )
        return reject(413);
      if (index < 2) {
        if (
          request.method !== "GET" ||
          (request.headers.origin && request.headers.origin !== own)
        )
          return reject(403);
        if (
          request.headers["transfer-encoding"] ||
          Number(request.headers["content-length"] ?? 0) !== 0
        )
          return reject(413);
        if (url.search && url.pathname !== "/auth/callback") return reject(404);
        if (url.pathname === "/auth/config") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(providers[index]!.config));
          return;
        }
        const asset = assets.get(url.pathname);
        if (!asset) return reject(404);
        response.writeHead(200, {
          "Content-Type": asset.type + "; charset=utf-8",
        });
        response.end(asset.data);
        return;
      }
      if (index === 2) {
        if (url.pathname === "/authorize" && request.method === "GET") {
          const provider = providers.find(
            (p) =>
              p.config.redirectUri === url.searchParams.get("redirect_uri"),
          );
          if (!provider) return reject(400);
          response.writeHead(302, { Location: provider.authorize(url.href) });
          response.end();
          return;
        }
        if (
          url.pathname !== "/token" ||
          url.search ||
          request.method !== "POST" ||
          request.headers.cookie ||
          request.headers.authorization ||
          !/^application\/x-www-form-urlencoded(?:;|$)/i.test(
            request.headers["content-type"] ?? "",
          )
        )
          return reject(403);
        const raw = await body(request),
          fields = new URLSearchParams(raw);
        const provider = providers.find(
          (p) => p.config.redirectUri === fields.get("redirect_uri"),
        );
        if (!provider || request.headers.origin !== provider.config.appOrigin)
          return reject(403);
        const result = await provider.fetch(url.href, {
          method: "POST",
          body: raw,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        });
        response.setHeader(
          "Access-Control-Allow-Origin",
          provider.config.appOrigin,
        );
        response.setHeader("Vary", "Origin");
        response.writeHead(result.status, {
          "Content-Type": "application/json",
        });
        response.end(await result.text());
        return;
      }
      if (request.headers.cookie) return reject(403);
      if (
        url.search ||
        !["/session", "/sessions/revoke"].includes(url.pathname) ||
        !["GET", "POST", "OPTIONS"].includes(request.method ?? "")
      )
        return reject(404);
      stats.apiRequests++;
      if (request.method === "OPTIONS") stats.preflights++;
      const headers: Record<string, string> = {};
      for (const name of [
        "origin",
        "authorization",
        "content-type",
        "access-control-request-method",
        "access-control-request-headers",
      ])
        if (typeof request.headers[name] === "string")
          headers[name] = request.headers[name];
      const result = await context.mf.dispatchFetch(
        "http://localhost" + url.pathname,
        {
          method: request.method!,
          headers,
          ...(request.method === "POST" ? { body: await body(request) } : {}),
        },
      );
      for (const [name, value] of result.headers)
        response.setHeader(name, value);
      response.writeHead(result.status);
      response.end(Buffer.from(await result.arrayBuffer()));
    };
    return {
      app,
      secondary,
      idp,
      api,
      proxy,
      context,
      providers,
      stats,
      close: stop,
    };
  } catch {
    await stop();
    throw new Error("認証fixtureを準備できません。");
  }
}
