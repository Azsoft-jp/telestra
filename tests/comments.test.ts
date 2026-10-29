// 日本語コメントの検査が、文字列・URL・正規表現・機械向け指示を誤認しないか確認する。
import assert from "node:assert/strict";
import { checkJapaneseComments } from "../scripts/check-japanese-comments.ts";
import { scenario } from "./evidence.ts";

scenario(
  "PH00-02",
  "japanese-comment-policy",
  "comment-source-fixtures-v1",
  "日本語コメントを必須とし、文字列の日本語や機械向け指示を説明コメントと混同しない",
  () => {
    assert.deepEqual(
      checkJapaneseComments(
        "sample.ts",
        '// 接続先を固定して入力による変更を防ぐ。\nconst url="https://example.test";const marker=/^\\/\\//;',
      ),
      [],
    );
    assert.equal(
      checkJapaneseComments(
        "sample.ts",
        'const text="日本語の文字列だけではコメント要件を満たさない";',
      ).length,
      1,
    );
    assert.ok(
      checkJapaneseComments(
        "sample.ts",
        "// 処理の目的を説明する。\n// This comment must be localized.\nconst value=1;",
      ).some((issue) => issue.includes("日本語で記載")),
    );
    assert.deepEqual(
      checkJapaneseComments(
        "sample.ts",
        "// 対応しない型の拒否を検証する。\n// @ts-expect-error\nconst value: string=1;",
      ),
      [],
    );
    assert.deepEqual(
      checkJapaneseComments(
        "sample.ts",
        "// 失敗を記録する。\ntry {} catch { /* 例外の値は出力しない。 */ }",
      ),
      [],
    );
    for (const [name, source] of [
      ["sample.go", "// 外部接続を行わない。\npackage sample"],
      ["sample.py", "#!/usr/bin/env python3\n# 合成素材だけを処理する。\n"],
      ["sample.sql", "-- 秘密値を保存しない。\nSELECT 1;"],
    ])
      assert.deepEqual(checkJapaneseComments(name!, source!), []);
  },
);
