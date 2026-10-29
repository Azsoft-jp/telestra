// 手書きコードの日本語コメントを検査し、文字列中の日本語をコメントとして数えない。
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const japanese = /[ぁ-んァ-ヶ一-龠]/;
const generated = new Set([
  "packages/contracts/generated.ts",
  "packages/control-contracts/runtime.mjs",
  "packages/control-contracts/runtime.d.mts",
]);
const extensions = new Set([
  ".ts",
  ".mjs",
  ".go",
  ".py",
  ".sql",
  ".yml",
  ".html",
  ".css",
  ".tf",
  ".hcl",
  ".toml",
]);

// TypeScript系は構文木の位置からコメントを抽出し、URLや正規表現との誤認を避ける。
export function checkJapaneseComments(name: string, source: string): string[] {
  const comments: { text: string; line: number }[] = [];
  const extension = extname(name);
  if ([".ts", ".mjs"].includes(extension)) {
    const syntax = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      extension === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const positions = new Set<number>();
    const collect = (ranges: ts.CommentRange[] | undefined): void => {
      for (const range of ranges ?? []) {
        if (positions.has(range.pos)) continue;
        positions.add(range.pos);
        comments.push({
          text: source.slice(range.pos, range.end),
          line: source.slice(0, range.pos).split("\n").length,
        });
      }
    };
    const visit = (node: ts.Node): void => {
      collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
      collect(ts.getTrailingCommentRanges(source, node.end));
      if (ts.isBlock(node))
        collect(ts.getLeadingCommentRanges(source, node.getStart(syntax) + 1));
      ts.forEachChild(node, visit);
    };
    visit(syntax);
  } else if ([".html", ".css"].includes(extension)) {
    for (const match of source.matchAll(/<!--[^]*?-->|\/\*[^]*?\*\//g))
      comments.push({
        text: match[0],
        line: source.slice(0, match.index).split("\n").length,
      });
  } else {
    const marker =
      extension === ".go"
        ? /^\s*\/\//
        : extension === ".sql"
          ? /^\s*--/
          : /^\s*#(?!\!)/;
    source.split("\n").forEach((text, index) => {
      if (marker.test(text)) comments.push({ text, line: index + 1 });
    });
  }
  const issues: string[] = [];
  if (!comments.some((comment) => japanese.test(comment.text)))
    issues.push(`${name}: 日本語コメントがありません。`);
  for (const comment of comments) {
    // ライセンスやコンパイラ向けの指示は、書式を変更すると意味が変わるため除外する。
    const machine =
      /^(?:\/\/|\/\*|#|--)\s*(?:@(?:ts-|__PURE__|__NO_SIDE_EFFECTS__)|go:|eslint-|c8\b|istanbul\b|prettier-|SPDX-|Copyright\b)/.test(
        comment.text.trim(),
      );
    if (
      !machine &&
      !japanese.test(comment.text) &&
      /[A-Za-z]{3}/.test(comment.text)
    )
      issues.push(
        `${name}:${comment.line}: 説明コメントを日本語で記載してください。`,
      );
  }
  return issues;
}

// 依存物と生成物を避け、リポジトリで管理する実装・検査コードだけを走査する。
function inspect(directory: string): string[] {
  const issues: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      ["node_modules", "artifacts", ".git", "__pycache__"].includes(entry.name)
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) issues.push(...inspect(path));
    else if (
      entry.isFile() &&
      extensions.has(extname(path)) &&
      !generated.has(path)
    )
      issues.push(...checkJapaneseComments(path, readFileSync(path, "utf8")));
  }
  return issues;
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const issues = [
    "apps",
    "packages",
    "nodes",
    "scripts",
    "tests",
    ".github",
    "ops",
  ].flatMap(inspect);
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  } else console.log("PASS: 手書きコードの日本語コメントを確認しました。");
}
