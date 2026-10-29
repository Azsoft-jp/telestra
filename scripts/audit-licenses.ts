// lockfileのSPDXを一覧化する。第三者の利用条件を本体のMITへ置き換えない。
import { readFileSync, writeFileSync } from "node:fs";
interface Package {
  version?: string;
  license?: string;
  link?: boolean;
}
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<string, Package>;
};
const known = new Set([
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "0BSD",
  "CC0-1.0",
  "LGPL-3.0-or-later",
  "CC-BY-4.0",
  "OFL-1.1",
]);
const rows: string[] = [];
for (const [path, value] of Object.entries(lock.packages).sort(([a], [b]) =>
  a.localeCompare(b, "en"),
)) {
  if (!path.startsWith("node_modules/") || value.link) continue;
  if (
    !value.version ||
    !value.license ||
    value.license
      .split(/\s+(?:AND|OR)\s+|[()]/)
      .filter(Boolean)
      .some((x) => !known.has(x))
  )
    throw new Error("第三者ライセンスの再確認が必要です。");
  rows.push(
    `| ${path.replace(/^node_modules\//, "")} | ${value.version} | ${value.license} |`,
  );
}
const output = `# 第三者ライセンス一覧\n\n本体と独自アセットはMIT。以下はpackage-lock.jsonに固定した依存物のSPDX申告であり、本体のライセンスで再許諾するものではない。node_modulesと第三者バイナリはGitへ同梱しない。実際の配布物を作る際は、元のLICENSE/NOTICE、LGPL等のソース提供・リンク条件、再配布条件を確認する。この一覧だけで法的適合性を保証しない。\n\nGoのgithub.com/coder/websocket v1.8.15はISCで、[原文](LICENSES/ISC-coder-websocket.txt)を保持する。Go標準ライブラリはGo配布物の条件に従う。SAP Fundamental StylesはApache-2.0で、第三者CSSを改変せず固定依存として使用する。\n\n| npm依存物 | 版 | SPDX申告 |\n| --- | --- | --- |\n${rows.join("\n")}\n\n検査用のGitleaksはMIT、govulncheckはGoプロジェクトのライセンス、TerraformはHashiCorpの配布条件に従う。これらは別途取得するツールであり、Telestraのソース配布へ実行バイナリを含めない。PlaywrightはApache-2.0の検証用依存物である。Chromiumと同梱物は取得物のLICENSEに従い、ブラウザのバイナリをソース配布やGo TunerNodeへ含めない。ツールと依存物のバージョン更新時は元の条件も確認する。\n`;
if (process.argv.includes("--write"))
  writeFileSync("THIRD_PARTY_NOTICES.md", output);
else if (readFileSync("THIRD_PARTY_NOTICES.md", "utf8") !== output)
  throw new Error("第三者一覧を再生成してください。");
console.log(
  `PASS: npm依存物${rows.length}件のSPDX申告とGoのISC表記を確認しました。`,
);
