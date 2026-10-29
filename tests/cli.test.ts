// ローカル起動の出力を確認し、外部環境と未知のBackendの起動を拒否する。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { scenario } from "./evidence.ts";

scenario(
  "CORE-01",
  "local-profile-startup",
  "deployment.local.json",
  "例示プロファイルから起動し、外部環境は実行前に拒否する",
  () => {
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "scripts/mock.ts", ...args],
        { encoding: "utf8", timeout: 30_000 },
      );
    const local = run([
      "--profile",
      "examples/deployment.local.json",
      "--backend",
      "mirakurun",
    ]);
    assert.equal(local.status, 0, local.stderr);
    const result = JSON.parse(local.stdout) as {
      sourceBytes: number;
      playback: { state: string; manifest: { playable: boolean } };
    };
    assert.equal(result.sourceBytes, 2444);
    assert.equal(result.playback.state, "mock-ready");
    assert.equal(result.playback.manifest.playable, false);
    const external = run(["--profile", "examples/deployment.dual-static.json"]);
    assert.equal(external.status, 1);
    assert.match(external.stderr, /NOT_IMPLEMENTED/);
    assert.equal(external.stdout, "");
    const unknown = run(["--backend", "https://example.test"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /INVALID_BACKEND/);
  },
);
