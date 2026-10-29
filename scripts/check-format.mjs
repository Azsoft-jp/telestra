// TypeScript系の書式とGoの整形状態を検査し、必要な修正を検出する。
import { execFileSync } from "node:child_process";

execFileSync(
  process.execPath,
  [
    "node_modules/prettier/bin/prettier.cjs",
    "--check",
    "**/*.{ts,mjs,json,yml,html,css}",
  ],
  { stdio: "inherit" },
);
const files = execFileSync(
  "gofmt",
  ["-l", "nodes/tuner", "scripts/checkerrors"],
  { encoding: "utf8" },
).trim();
if (files) throw new Error(`gofmtが必要です: ${files}`);
