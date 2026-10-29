// CLIの親子IPCで停止を確認する。子の上流ログは表示せず、既知のloopback通知だけを読む。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { scenario } from "../evidence.ts";

scenario(
  "CORE-02",
  "auth-fixture-cli-graceful-stop",
  "detached-fixture-child-stop-ipc-v1",
  "Miniflareのsignal hookを親CLIから分離し、SIGTERMで停止通知・後始末・終了コード0を確認する",
  async () => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "scripts/auth-demo.ts"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      invalid = false;
    const exited = new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    child.stderr.on("data", () => {
      invalid = true;
    });
    child.stdout.setEncoding("utf8");
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("認証fixtureの起動を確認できません。")),
          15_000,
        );
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.length > 8192) {
            invalid = true;
            clearTimeout(timer);
            reject(new Error("起動通知の上限を超えました。"));
          }
          if (/Telestra 認証fixture: https:\/\/127\.0\.0\.1:\d+/.test(output)) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("親CLIを起動できません。"));
        });
      });
      child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("認証fixtureを終了できません。")),
              6000,
            );
          }),
        ]);
        assert.equal(code, 0);
        assert.equal(invalid, false);
        assert.equal(
          output.includes("認証fixtureの終了処理を確認しました。"),
          true,
        );
      } finally {
        clearTimeout(timer);
      }
    } finally {
      // 親が中断しても専用子はIPC切断を検知して終了する。自分の親CLI以外のPIDは扱わない。
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
  },
);
