# 制御APIの本文期限と中断

2026年10月29日のPhase 01追加実装を記録する。[ADR-025](architecture/decisions/ADR-025-control-body-deadline.md)に従い、WorkerとDOのJSON本文に共通の読み取り処理を追加した。Phase 01全体は未完了である。

## 目的と変更

Workerには8KiBの上限があったが、入力が途中で止まると待ち続けた。DOもrequest.textの後でサイズを検査していた。apps/control/body.tsで、本文の読取開始から5秒、8192バイト、readの16384回を制限する。到着のたびに期限を戻さず、期限後のEOFや完了も拒否する。

Content-Lengthの形式と実量、UTF-8、JSONのContent-Typeを照合し、圧縮を拒否する。中断はRequest.signalで受け、ローカルfixtureでenable_request_signalを有効にした。失敗時は入力値やsourceの例外を応答へ出さない。未完の入力へcancelを一度要求し、timer・listener・lockを回収する。cancelの完了を待たず、正常時のlock解放に失敗すれば503を返す。

WorkerからDOへ検査済みJSONを渡す際は、元の長さ・圧縮・転送方式のヘッダーを削除する。Schema、認証、認可、命令の署名、永続台帳の責務は維持する。TunerNode、媒体転送、Capture Permitの未決定事項、本番のKeyProviderは変更しない。

## 検証

承認済みの依存物を用意したNode.js 24.22.1、Go 1.26.10の環境で実行する。新しい外部依存物は追加しない。

```sh
npm run control:build
node --experimental-strip-types --test tests/phase01/body.test.ts tests/phase01/body-http.test.ts
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run check
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run browser:check
```

| 対象 | 実行結果と範囲 |
| --- | --- |
| 追加7試験 | macOS arm64で成功。Node Streamと模擬時計の5件、ローカルHTTP・Worker・D1・DOの2件 |
| 本文の境界 | 分割UTF-8、8192バイト、長さ不一致、圧縮、不正UTF-8、空chunkの過多を検査 |
| 停止・失敗・中断 | 全体期限、期限後の入力、開始前・途中のAbortSignal、source例外、cancel停止・失敗、正常時のlock解放失敗を検査 |
| 実HTTP | 途中で止めたchunked要求を約5.2秒で408にし、不正入力をD1へ保存しないことと、次の予約要求の202を確認 |
| DOへの転送 | 空白付きJSONと元の長さの不一致を修正し、命令の配送と同じIDの再送を確認 |
| npm run check | 終了コード0。既存16件とPhase 01の48件、Go全体のrace、型・契約・書式・日本語コメント・公開前検査が成功 |
| npm run browser:check | Chromiumの3件とCLI終了の1件が成功。変更後のAPIでもpopup認証・失効・origin分離を確認 |
| 秘密・公開情報 | Gitleaksは作業ツリーと全ref履歴で検出0件。公開前検査は250ファイルと履歴を検査して検出0件 |

未実装の入口で最初の4試験が失敗することを確認した。追加の型検査ではWorkerと標準StreamのEOF型の差があり、undefinedを明示して受け取るよう直した。listener確認の誤配置による試験の失敗も修正した。DOへの転送試験では、元のContent-Lengthを引き継いだ正常要求が400になることを再現し、ヘッダーを作り直して202と配送を再確認した。

## 変更ファイル

手書きコードはapps/control/body.ts、index.ts、registry.ts、tests/phase01/body.test.ts、body-http.test.ts、helper.tsである。ADR、進捗、runbook、受け入れ基準、索引、変更履歴を更新する。[全変更一覧](implementation-files.md)でも追跡する。

## 未確認・限界・次の入力

AbortSignalは合成sourceで検査した。実クライアントの切断から基盤の回収までの時間、実Cloudflare、Proxy、低速回線、長時間・並行負荷は未検証である。本文の5秒は、認証やD1の待機を含むAPI全体の期限ではない。cancelの要求が、上流での回収完了を保証するわけでもない。

既に確定した更新を中断で取り消す機能は追加していない。実IdP、OSと本番KeyProvider、Capture Permitの署名・失効、本番の負荷制限は引き続き次の入力・実装を要する。このローカル試験の成功を、Phase 01全体や本番DoS耐性の合格とは扱わない。
