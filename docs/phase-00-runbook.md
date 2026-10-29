# Phase 00の実行手順

この文書の版番号はPhase 00当時の検証記録を含む。現在の導入は[Getting Started](getting-started.md)に従い、Go 1.26.10を使用する。

## 前提と実行範囲

Node.js 24、npm 11、Go 1.23以降、Python 3.11以降を使用する。今回のローカル確認はNode.js 24.22.1、npm 11.19.1、Go 1.26.8、Python 3.14.8、macOS arm64で実施した。CIもNodeとGoの確認版を固定している。各ライブラリは`package-lock.json`に固定する。

初回は`npm ci --ignore-scripts --no-audit --no-fund`を実行する。依存物がローカルキャッシュにあれば`--offline`も指定できる。テストとMockはネットワーク接続、Cloudflare/AWS/IdPの資格情報、チューナー、GPUを使わない。初回の依存物取得とCIのツール取得にはネットワークが必要になる。

## コマンド

リポジトリのルートで実行する。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run mock -- --profile examples/deployment.local.json --backend mirakurun
npm run mock -- --profile examples/deployment.local.json --backend mirakc
```

Mock起動はGoの合成チューナー、API、台帳、Storage、模擬変換を同じローカル検証処理で実行し、結果のJSONを出して終了する。WebサーバーやブラウザUIは起動しない。例示originへ接続しない。時計は`2026-10-29T00:00:30Z`に固定し、期限付きEnvelopeのfixtureを再現可能にする。

成功時は`sourceBytes:2444`、4チャンク、元と同じSHA-256、変換前`waiting`、変換後`mock-ready`を表示する。変換後も`playable:false`であり、映像は再生できない。`postEncode:false`のローカルプロファイルでは原本を保存し、`waiting`を返す。

`examples/deployment.dual-static.json`は設計例としてSchema検証するだけである。Mock起動へ渡すと`NOT_IMPLEMENTED`で終了する。staging/production、外部Storage、live、offline library、dual-staticの実行は拒否する。

Goだけを確認する場合は次を使う。出力は合成データを含むJSONであり、実放送は含まない。

```sh
go run ./nodes/tuner/cmd/mock --backend mirakc --packet-size 204
npm run test:go
```

## 検査の分担

| コマンド | 確認する内容 |
| --- | --- |
| `python3 scripts/validate_package.py` | 配布物、相対リンク、既存例の限定的なSchema検査 |
| `npm run generate` | JSON Schemaから型とWorker用検証器を再生成 |
| `npm run contract:check` | 型・検証器の生成差分、全Schemaのコンパイル、例示JSONのDraft 2020-12検証 |
| `npm run lint` | TypeScript strict、未使用項目、書式、日本語コメント、Go vet、Goのerror戻り値の破棄検出 |
| `npm test` | `CORE-01/02`、`MED-01`とローカル起動の正常・異常系 |
| `npm run test:go` | GoのMockとエラー検査器をrace検査付きで実行 |
| `npm run control:check` | Workerとローカル試験の型検査、ビルド、ローカル認証の部分試験 |
| `npm run check` | 配布物、契約、静的検査、Phase 00のTS・Go試験、ローカル認証の部分試験を順に実行 |

Goの戻り値検査器は標準ライブラリのASTと型情報を使い、呼び捨て、`_`への代入、defer/goによるerrorの破棄を拒否する。完全なデータフロー解析、外部のerrcheck、脆弱性検査の代替ではない。異常例と正常例を含む自己テストを持つ。

試験記録は`artifacts/phase00-results.json`、`artifacts/go-results.json`、実行ログへ保存する。各TS試験は`testId/commit/environment/fixtureId/expected/actual/status/evidenceUri/timestamp`を含む。Git未初期化時のcommitはnullとし、ソースのSHA-256を別に記録する。未実行の試験は合格に含めない。CIは読取権限だけを持ち、deploy/apply/secret取得の工程を持たない。

`npm test`は必須の`CORE-01/02`と`MED-01`のpassがすべて存在することも確認する。証跡の不正・重複、skip、fail、必須ID不足、試験プロセスの異常があれば終了コード1を返す。`acceptance`で判定理由を、`testProcessExitCode`で試験プロセスの結果を確認できる。`exitCode`は受け入れ判定を含めたコマンドの結果である。試験を直接指定して実行した場合は`artifacts/evidence/`配下へ独立した証跡を残すが、一括受け入れの合格には読み替えない。

## 未実装の境界

`apps/web`は日本語の状態文言と境界説明だけである。空、待機、失敗、切断、復帰中、権限なしを区別する。実際のUI、SAP Styles、Service Worker、端末保存、二重静的配信は未実装。別originの保存領域とログインは独立し、予備UIの表示をbackend復旧とは扱わない。

`MockActor`と`MockGrant`はテスト側が与える信頼済みの文脈である。署名も認証も提供しない。境界の認可条件は否定試験で確認するが、インターネットへ公開できるAPIではない。認証前の公開サーバーへ転用しない。
