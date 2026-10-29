# はじめてのTelestra

まずDemoで、原本保存と再生用変換の違いを確認する。チューナー、Cloudflare、IdP、GPU、アカウントは不要で、課金リソースも作らない。依存物の初回取得にはインターネットが必要になる。

前提はNode.js 24、npm 11、Go 1.26.10、Python 3.11以降。全検査で使う固定版はCIのNode.js 24.22.1、Go 1.26.10である。Goの脆弱性検査ツールはGo 1.26以降を必要とする。

```sh
git clone https://github.com/Azsoft-jp/telestra.git
cd telestra
npm ci --ignore-scripts --no-audit --no-fund
go mod download
npm run telestra -- demo
```

表示されたhttp://127.0.0.1:5173をブラウザで開く。原本2,444バイト、4チャンク、映像再生は未実装と表示されればDemoの結果を確認できている。原本のhashも表示する。画面の状態切替は見本であり、実録画や権限を変更しない。ログは起動したターミナルへ出る。終了はCtrl+C。

画面を使わずに同じMockを確認する場合は次を実行する。

```sh
npm run telestra -- mock --profile examples/deployment.local.json --backend mirakurun
npm run telestra -- mock --profile examples/deployment.local.json --backend mirakc
npm run check
```

成功時もplayable:falseのままである。合成バイトを再構築した証拠を、実Codec・ARIB字幕・視聴成功と解釈しない。

次は[導入モード](installation.md)、[設定](configuration.md)、[困ったとき](troubleshooting.md)へ進む。Minimal以降は計画中で、実チューナーに接続する導入コマンドはまだ提供していない。Docker Composeも未提供である。今回の端末ではDocker daemonが動作しておらず、コンテナ導入を検証していない。

## 開発者向けの認証fixture

[popupとChromiumの検証手順](phase-01-popup.md)では、合成IdPとローカルWorkerで認可結果の復帰を確認できる。固定版Playwrightとheadless Chromiumを使い、自己署名TLSを隔離した試験contextで扱う。通常のDemoとは別の開発者向けfixtureで、実アカウントを使わない。
