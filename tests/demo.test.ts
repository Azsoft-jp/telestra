// 実際のループバックHTTPでDemoの成功と境界拒否を確認する。実機と外部サービスは使わない。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { scenario } from "./evidence.ts";

scenario(
  "PUB-04",
  "loopback-demo-and-cli",
  "synthetic-demo-v1",
  "公開CLIでDemoを起動し、合成結果とHost/Origin/操作/サイズの拒否を確認する",
  async () => {
    const help = spawnSync(
      process.execPath,
      ["scripts/telestra.mjs", "--help"],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Telestra/);
    const denied = spawnSync(
      process.execPath,
      ["scripts/telestra.mjs", "shell"],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(denied.status, 1);
    const child = spawn(
      process.execPath,
      ["scripts/telestra.mjs", "demo", "--port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    let output = "";
    let errors = false;
    child.stderr.on("data", () => {
      errors = true;
    });
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Demoの起動が時間内に完了しません。")),
        10000,
      );
      child.stdout.on("data", (value: Buffer) => {
        output += value.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
        if (output.length > 8192) {
          clearTimeout(timer);
          reject(new Error("起動通知が上限を超えました。"));
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Demoを起動できません。"));
      });
    });
    try {
      const page = await fetch(endpoint);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /合成データを表示するMock UI/);
      assert.match(
        page.headers.get("content-security-policy") ?? "",
        /default-src 'none'/,
      );
      const result = (await (await fetch(endpoint + "/api/demo")).json()) as {
        sourceBytes: number;
        chunks: number;
        playback: { manifest: { playable: boolean } };
      };
      assert.equal(result.sourceBytes, 2444);
      assert.equal(result.chunks, 4);
      assert.equal(result.playback.manifest.playable, false);
      for (const path of [
        "/demo.mjs",
        "/demo.css",
        "/logo.svg",
        "/favicon.svg",
        "/fundamental-button.css",
        "/fundamental-table.css",
      ])
        assert.equal((await fetch(endpoint + path)).status, 200);
      assert.equal(
        (
          await fetch(endpoint + "/api/demo", {
            headers: { Origin: "https://evil.example.invalid" },
          })
        ).status,
        403,
      );
      assert.equal(
        (await fetch(endpoint + "/api/demo", { method: "POST", body: "{}" }))
          .status,
        405,
      );
      assert.equal(
        (await fetch(endpoint + "/api/demo?url=https://example.invalid"))
          .status,
        404,
      );
      assert.equal((await fetch(endpoint + "/package.json")).status, 404);
      const code = await new Promise<number | undefined>((resolve, reject) => {
        const call = request(
          endpoint,
          { headers: { host: "evil.example.invalid" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        call.on("error", reject);
        call.end();
      });
      assert.equal(code, 403);
      const large = await new Promise<number | undefined>((resolve, reject) => {
        const call = request(
          endpoint + "/api/demo",
          { method: "GET", headers: { "Content-Length": "20000" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        call.on("error", reject);
        call.end("x".repeat(20000));
      });
      assert.equal(large, 413);
      assert.equal(errors, false);
    } finally {
      child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("Demoを終了できません。"));
            }, 5000);
          }),
        ]);
        assert.equal(code, 0);
      } finally {
        clearTimeout(timer);
      }
    }
  },
);
