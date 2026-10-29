// 制御Workerをローカル用に束ねる。デプロイやクラウド資源の作成は行わない。
import { build } from "esbuild";
await build({
  entryPoints: ["apps/control/index.ts"],
  outfile: "artifacts/control/worker.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  minify: false,
  sourcemap: false,
});
console.log(
  "PASS: ローカル制御Workerをビルドしました（デプロイは行いません）。",
);
