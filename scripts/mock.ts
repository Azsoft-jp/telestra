// Mockの引数を検査して合成結果を表示する。既存のnpm run mockも維持する。
import { BoundaryError } from "../packages/contracts/index.ts";
import { runMock } from "./mock-run.ts";

function main(): void {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key ||
      !["--profile", "--backend"].includes(key) ||
      !value ||
      options[key]
    )
      throw new BoundaryError(
        "INVALID_OPTIONS",
        "起動引数を確認してください。",
      );
    options[key] = value;
  }
  const result = runMock(
    options["--profile"] ?? "examples/deployment.local.json",
    options["--backend"] ?? "mirakurun",
  );
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  // エラーにファイル内容、入力値、資格情報を含めず、固定した説明を返す。
  console.error(
    error instanceof BoundaryError
      ? `${error.code}: ${error.message}`
      : "Mockを起動できませんでした。引数とローカル環境を確認してください。",
  );
  process.exitCode = 1;
}
