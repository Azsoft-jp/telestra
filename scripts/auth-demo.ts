// Miniflareのsignal hookを親CLIから分離し、固定した子プロセスへ停止だけを通知する。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 2) {
  console.error("使い方: npm run auth:demo");
  process.exit(1);
}
const child = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./auth-fixture-child.ts", import.meta.url)),
  ],
  {
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, DEBUG: "", PWDEBUG: "0", SSLKEYLOGFILE: "" },
  },
);
let closing = false,
  stopped = false,
  invalid = false,
  ready = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const startup = setTimeout(() => {
  invalid = true;
  stop();
}, 35_000);
function stop() {
  if (closing) return;
  closing = true;
  timer = setTimeout(() => {
    invalid = true;
    // 自分が起動した専用process groupだけを回収する。外部のPIDは入力にしない。
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 5000);
  if (child.connected)
    child.send({ type: "telestra.fixture.stop.v1" }, (error) => {
      if (error) invalid = true;
    });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
child.on("error", () => {
  invalid = true;
  console.error("認証fixtureを起動できません。");
  process.exitCode = 1;
});
child.stderr?.on("data", () => {
  invalid = true;
  stop();
});
function loopback(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === "https:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== ""
    );
  } catch {
    return false;
  }
}
// 通知は既知の項目だけを扱い、予期しない値や上流エラーの本文をログへ出さない。
child.on("message", (value: unknown) => {
  if (typeof value !== "object" || value === null || !("state" in value)) {
    invalid = true;
    stop();
    return;
  }
  const fields = Object.keys(value).sort().join(",");
  if (
    value.state === "ready" &&
    fields === "app,secondary,state" &&
    "app" in value &&
    "secondary" in value &&
    loopback(value.app) &&
    loopback(value.secondary) &&
    !ready
  ) {
    ready = true;
    clearTimeout(startup);
    if (closing) return;
    console.log(
      `Telestra 認証fixture: ${value.app}\n別origin: ${value.secondary}\n合成IdPとAPIのみ。自己署名TLS。終了はCtrl+C。`,
    );
  } else if (value.state === "stopped" && fields === "state" && closing)
    stopped = true;
  else {
    invalid = true;
    stop();
  }
});
child.on("close", (code) => {
  clearTimeout(timer);
  clearTimeout(startup);
  if (closing && stopped && code === 0 && !invalid)
    console.log("認証fixtureの終了処理を確認しました。");
  else {
    console.error("認証fixtureの起動または終了を確認できません。");
    process.exitCode = 1;
  }
});
