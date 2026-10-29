# Phase 01のローカル認証・接続試験

本番資源を作らず、実機・実IdP・実録画へ接続せずに再現する。Phase 01全体の完了条件と残作業は[実装状況](phase-01-progress.md)を参照する。

## 実行

Node.js 24、Go、Pythonを使用する。npm依存物はlockfile、Go依存物はgo.modとgo.sumに固定する。ローカルキャッシュがある場合は次の順で実行する。

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run check
```

個別に確認する場合は、リポジトリのルートで次を実行する。

```sh
npm run contract:check
npm run control:check
go test -race ./nodes/tuner/control ./nodes/tuner/wire
```

`control:check`はWorkerと試験の型検査、ローカルビルド、認証・接続試験を行う。D1とDOは試験ごとの一時保存先で動かし、試験終了時に破棄する。署名鍵は試験中に生成し、既存の資格情報を取得しない。外向きfetchは拒否する。

無通信切断の試験は実際のDO alarmを待つため、約45秒かかる。成功表示が出る前に合格とは扱わない。Miniflare内のWebSocket Upgradeに加え、GoからループバックTLSへのWSS接続も試験する。GoのHeartbeat試験は15秒、helloの受領待ちは10秒を実際に待つ。実環境のWSS接続、TLS証明書、プロキシ越しの通信は未検証である。

初回にGo依存物のキャッシュがない場合は、承認済みの公開依存物を取得する。取得後の検査では外部取得を止める。CIもこの順に実行する。

```sh
GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org go mod download
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go mod verify
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run check
```

## 証跡

`artifacts/phase01-results.json`に試験ID、環境、fixture、期待と実際の結果、pass/fail、時刻、ソースのSHA-256、実行ログの参照を記録する。Git未初期化の作業領域ではcommitはnullとなる。各試験は同じIDでも名前を分け、証跡を上書きしない。`phaseCompletion`は`incomplete`のままとし、部分試験の合格をPhase全体の完了へ読み替えない。

Goの再接続・署名・永続履歴試験は`artifacts/go-results.json`と`artifacts/go-test-output.txt`へ含める。GoとWorkerの相互検証は固定したfixtureコマンドを使う。鍵とTokenはIPCだけで受け渡し、コマンドの出力をログへ転記しない。WSS試験用の固定コマンドは、ループバック以外への接続を拒否する。試験TLS鍵と証明書もIPCで渡し、ファイルへ保存しない。Workerの停止・再起動で同じ接続先への再接続を確認する。確定予約と媒体の実行は行わない。

## 管理とNodeの境界

Workerには`development`以外を拒否するガードがあり、本番用のデプロイ設定は提供していない。手動起動で本番のTokenや鍵を設定せず、試験fixtureを利用する。

Nodeの`/agent`はBearer資格と端末鍵の一回限りの接続証明で認証し、Originを持つBrowser接続を拒否する。利用者の管理操作は許可Originとoperator/adminを要求する。接続状態は`/nodes/:nodeId/connection`、限定命令は`POST /nodes/:nodeId/commands`で扱う。HTTP 202は送信待ちへの登録を表し、録画の実行成功を表さない。

試験Nodeは`capture.start/cancel`を実行しない。構造だけのPermitや模擬ACKを、録画原本・字幕・音声の保存成功として扱わない。汎用Shell、任意URL取得、任意ファイル書込、動画転送をこの経路へ追加しない。
