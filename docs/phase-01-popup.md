# popupによる認可結果の復帰とChromium試験

2026年10月29日のPhase 01追加実装を記録する。[ADR-024](architecture/decisions/ADR-024-auth-popup-fixture.md)に従い、既存のメモリ内PKCEへwindowの照合と画面への復帰を追加した。これは合成IdPとローカルAPIの認証fixtureで、Telestra全体の完成したログイン画面ではない。Phase 01全体は未完了である。

## 変更と責務

packages/browser-auth/popup.tsはユーザー操作内でpopupを一つ開き、実originとWindowProxyのsource、callbackのSchemaと開始stateを照合する。callback.tsはURIの検証とqueryの消去、固定originへの通知、ACKを扱う。window.tsはブラウザのWindowProxyを変換する。APIの資格・認可と5秒・16KiB・同時4要求の制限は既存のBrowserSessionへ任せる。

同時開始を拒否し、popup拒否・閉じる・中断・120秒の期限・失敗・破棄を日本語で区別する。遅れた応答と再利用は採用しない。設定できたlistenerとtimerはその都度保持し、途中失敗でも回収する。callbackはURLを消してから一回だけ送信し、元のwindow・origin・stateに対応するACKを15秒だけ待つ。閉じる際のpagehideで確定したACKを失敗へ変えない。

apps/web/auth-fixtureはSAP Fundamental Stylesと角丸なしの確認画面を提供する。資格を表示せず、textContentで日本語の状態と合成ユーザーだけを表示する。押せない操作の見た目と、認証後のフォーカスも扱う。実録画、視聴、EPG、PWAは追加していない。

tests/browser/fixture.tsはWeb二つ、Mock IdP、APIを別のloopback TLS originで起動する。APIは既存のローカルWorker/D1を呼び、IdPはS256と一回限りの合成コードを検証する。外向き通信は転送しないproxyで拒否する。Host、固定経路、Origin、本文上限を検査し、管理用Node APIや任意URLの取得を公開しない。

## 再現する

Node.js 24.22.1、Go 1.26.10と既存の承認済みGo依存物を用意する。ブラウザ試験用にPlaywright 1.64.1を固定した。ブラウザの取得は初回または版の更新時に行う。[公式の導入方法](https://playwright.dev/docs/browsers)に従い、Linux CIではsystem dependenciesも取得する。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --only-shell chromium
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run check
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run browser:check
```

手動確認用の起動・終了コマンドは次のとおり。表示したURLはloopbackだけで、Ctrl+Cで合成鍵と台帳を破棄する。通常ブラウザでの自己署名証明書の一時許可は、自動試験の結果とは分ける。既存アカウントの資格を入力したり、システムの証明書ストアを変更したりする手順は提供しない。

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run auth:demo
```

自動試験は非永続Chromium contextに限定して自己署名TLSを許容する。通常の通信を横取りせずpreflightとCORSの拒否を確認し、送信元の試験でだけ合成IdP応答を置き換える。実環境の証明書を検証したものではない。trace、HAR、動画、storageState、TLS鍵ログは保存しない。

## 実行結果と失敗からの修正

| 対象 | 結果と範囲 |
| --- | --- |
| npm run check | macOS arm64で終了コード0。既存16試験、Phase 01の41試験、Go全体のrace、型・Schema生成差分・書式・日本語コメント・公開前検査が成功 |
| windowの追加5試験 | origin/source、Schema、再利用、拒否・終了・期限・中断・破棄、ACKの競合、部分設定の回収に成功 |
| npm run browser:check | macOS arm64のChromiumの3試験とCLI終了の1試験が成功。実popup・native CORS、別originの再ログイン、失効、再読込、送信元の拒否、URL消去、日本語・キーボード・幅とヘッダーを確認 |
| CLI起動・停止 | 親CLIへのSIGTERMで子の停止通知・後始末・終了コード0を確認。Ctrl+Cによるnpm wrapperの終了コード130とは区別 |
| 公開情報・依存物 | 作業ツリーと全ref履歴の秘密検出0件、公開前検査0件、npm auditとGo 1.26.10のgovulncheckも検出0件 |

最初のwindow契約試験は未実装で失敗した。実ブラウザではcallbackのCOOPでopenerが切れ、Token要求0件で停止することを再現し、通信専用ページだけの方針を分けて修正した。ACK確定前のcloseによるpagehide競合と、設定途中の失敗でwindow・listenerが残る問題も否定試験で再現して直した。

Playwrightのリクエスト横取りを全通信へ適用した試験では、API要求はあってもpreflightを観測できず失敗した。native通信と拒否専用proxyへ変更し、preflightと許可されないOriginの応答拒否を再検証した。これらの失敗は成功に読み替えず、修正後の試験結果と区別する。

手動CLIではMiniflareのsignal hookが非同期終了処理より先に終了コード143で止まることを再現した。専用の子process groupへfixtureを移し、親は固定したIPCの停止通知と子の終了を照合する。第三者のsignal handlerを削除せず、Miniflare本体も変更しない。停止完了を確認できない場合は失敗とし、自分が起動したgroupだけを期限付きで回収する。

依存実装には、NODE_ENVや明示設定によってRequest.cf補完用の外部取得へ進む経路があった。共通fixtureへcf:falseを明記し、この経路を止めた。過去の実取得の有無は未確認で、以前の外向き0件はWorkerのoutboundServiceだけの測定だった。ローカルcacheの実IP等は読み出していない。公開ツリーと履歴の検査に漏えいの検出はないが、依存ツール全体の過去の通信を0件と証明したものではない。

ブラウザfixtureと子プロセスは、Miniflareの宣言ファイルの既知の問題に合わせて専用tsconfigで検査する。アプリと認証ライブラリのstrict検査は維持し、第三者コードを変更しない。CIへbrowser jobを追加し、結果JSON、秘密のない実行ログ、親画面の合成画像だけを保存する。レポートのsourceDigestはHTML・CSS・SVGも含み、browser-results.jsonとPhase別記録を分ける。

## 未確認・限界・次の入力

Chromium以外、モバイルPWA、実IdP、MFA、実環境TLS、完全なWCAG適合、XSS侵入試験、本番KeyProviderは未検証である。画像とUX-08はauth fixtureだけの確認で、視聴UI全体の合格ではない。別originのPWAデータ共有やbackend DRを証明するものでもない。

本番のIdP、登録client/callback、対象ブラウザとPWA、COOP/CSP、鍵の更新・失効・復旧方式を次の入力とする。popupの信頼関係やCOOP例外を、ローカル試験の成功だけで本番へ移さない。全ファイルは[変更一覧](implementation-files.md)で追跡する。
