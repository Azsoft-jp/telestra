// MarkdownとHTMLのローカル参照を検査する。外部URLの到達性や実機能の保証には使わない。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
const root = process.cwd();
const failures: string[] = [];
let count = 0;
function walk(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        "artifacts",
        ".git",
        ".terraform",
        "__pycache__",
      ].includes(entry.name)
    )
      continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (![".md", ".html"].includes(extname(file))) continue;
    const text = readFileSync(file, "utf8");
    const links = [
      ...text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g),
    ].map((m) => m[1] ?? "");
    if (extname(file) === ".md")
      links.push(
        ...[...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? ""),
      );
    for (const target of links) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = decodeURIComponent(target.split("#")[0] ?? "");
      if (!path) continue;
      const destination = resolve(dirname(file), path);
      count++;
      if (!destination.startsWith(root + "/") || !existsSync(destination))
        failures.push(
          `${file.slice(root.length + 1)}: ローカル参照が不正です。`,
        );
    }
  }
}
walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`PASS: Markdownのローカル参照${count}件を確認しました。`);
