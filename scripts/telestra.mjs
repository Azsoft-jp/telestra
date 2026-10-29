#!/usr/bin/env node
// 公開CLIの入口を固定する。入力から任意のプログラムやShellを実行しない。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const command = process.argv[2] ?? "--help";
if (["--help", "-h"].includes(command)) {
  console.log(
    "Telestra\n\n使い方: telestra <demo|mock>\n  demo  チューナー不要のローカルMock UI\n  mock  合成録画の検証結果をJSONで表示\n\n実録画・本番デプロイはまだ利用できません。",
  );
} else if (command === "--version") {
  console.log("telestra 0.0.0 (開発中)");
} else if (["demo", "mock"].includes(command)) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL(`./${command}.ts`, import.meta.url)),
      ...process.argv.slice(3),
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: "inherit",
    },
  );
  child.on("error", () => {
    console.error("起動できませんでした。導入手順を確認してください。");
    process.exitCode = 1;
  });
  // CLIを中断した場合も子プロセスを残さない。
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 0 : (code ?? 1);
  });
} else {
  console.error(
    "対応するコマンドを指定してください。telestra --helpで確認できます。",
  );
  process.exitCode = 1;
}
