// 合成fixtureだけを表示するループバック専用サーバー。実機、外部API、秘密値へ接続しない。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { runMock } from "./mock-run.ts";

const args = process.argv.slice(2);
if (
  args.length !== 0 &&
  (args.length !== 2 ||
    args[0] !== "--port" ||
    !/^\d{1,5}$/.test(args[1] ?? ""))
) {
  console.error("使い方: telestra demo [--port 5173]");
  process.exit(1);
}
const port = Number(args[1] ?? "5173");
if (port > 65535) {
  console.error("ポート番号を確認してください。");
  process.exit(1);
}

// ファイル名はallowlistで固定し、要求パスをファイルパスとして使わない。
const routes = new Map<string, { type: string; body: Buffer | string }>();
for (const [path, file, type] of [
  ["/", "apps/web/demo/index.html", "text/html; charset=utf-8"],
  ["/demo.css", "apps/web/demo/demo.css", "text/css; charset=utf-8"],
  ["/demo.mjs", "apps/web/demo/demo.mjs", "text/javascript; charset=utf-8"],
  ["/logo.svg", "assets/brand/logo.svg", "image/svg+xml"],
  ["/favicon.svg", "assets/brand/icon.svg", "image/svg+xml"],
  [
    "/fundamental-button.css",
    "node_modules/fundamental-styles/dist/button.css",
    "text/css; charset=utf-8",
  ],
  [
    "/fundamental-table.css",
    "node_modules/fundamental-styles/dist/table.css",
    "text/css; charset=utf-8",
  ],
] as const)
  routes.set(path, { type, body: readFileSync(file) });
try {
  const result = runMock("examples/deployment.local.json", "mirakurun");
  routes.set("/api/demo", {
    type: "application/json; charset=utf-8",
    body: JSON.stringify(result),
  });
} catch {
  console.error(
    "合成fixtureを作成できません。Node.js・Goと依存物を確認してください。",
  );
  process.exit(1);
}

const server = createServer(
  { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
  (request, response) => {
    const allowed = new Set([
      `127.0.0.1:${boundPort}`,
      `localhost:${boundPort}`,
    ]);
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    const reject = (code: number, message: string) => {
      response.writeHead(code, {
        "Content-Type": "text/plain; charset=utf-8",
        Connection: "close",
      });
      response.end(message);
    };
    // HostとOriginを固定してDNS rebindingや他サイトからの操作を拒否する。
    if (
      !allowed.has(request.headers.host ?? "") ||
      (request.headers.origin &&
        request.headers.origin !== `http://${request.headers.host}`)
    )
      return reject(403, "許可されていない接続元です。");
    if (request.method !== "GET" && request.method !== "HEAD")
      return reject(405, "このDemoは読取専用です。");
    if (
      request.headers["transfer-encoding"] ||
      (request.headers["content-length"] &&
        request.headers["content-length"] !== "0")
    )
      return reject(413, "本文は送信できません。");
    const route = routes.get(request.url ?? "");
    if (!route) return reject(404, "ページが見つかりません。");
    response.writeHead(200, { "Content-Type": route.type });
    response.end(request.method === "HEAD" ? undefined : route.body);
  },
);
let boundPort = port;
server.on("error", () => {
  console.error("起動できません。ポートの使用状況を確認してください。");
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    process.exitCode = 1;
    return;
  }
  boundPort = address.port;
  console.log(
    `Telestra Demo: http://127.0.0.1:${boundPort}\n合成素材のみ・実映像再生なし。終了はCtrl+C。`,
  );
});
// 終了を有限時間で完了し、HTTP接続や検証データを残さない。
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
