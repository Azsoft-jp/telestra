# 導入モードと運用手順

現在実行できるのはDemoだけである。Minimal、Recommended、Productionは導入目標を整理した計画であり、動作する導入手順や対応保証ではない。

| 項目 | A Demo | B Minimal・計画中 | C Recommended・計画中 | D Production・計画中 |
| --- | --- | --- | --- | --- |
| 目的 | チューナー不要のMock UIと契約確認 | 原本録画とStorageの最小構成 | 変換・認証・EPG・PWAを含む日常利用 | 監視・バックアップ・復旧を含む運用 |
| 機材・OS | Node.js/Go/Pythonが動くPC | Linux、権利を持つチューナー、Mirakurun/mirakc、有限スプール、保存先 | 左記にEncodeNodeと対応GPU等、視聴端末 | 左記に独立した監視・バックアップ・復旧先 |
| アカウント | 不要 | 選ぶStorage等のアカウント | Cloudflare、IdP、Storage等 | 環境分離したCloudflare、二次配信先、監視等 |
| 費用 | PCと通信費。クラウド資源を作らない | 保存容量、転送、回線、チューナー等 | 左記にEncodeNode、IdP等 | 左記に二次配信、監視、保持・復元等 |
| 設定例 | examples/deployment.local.json | 設計のみ。実資源の例はまだ配布しない | 設計のみ | examples/deployment.dual-static.jsonはSchema検査用のみ |
| 成功判定 | 2,444バイト、4チャンク、playable:false | MED-01/02、REL-02/03/04、SEC-06等を今後検証 | EPG・実Codec・字幕・端末・PWAを今後検証 | SEC/REL/DRと実環境の復旧演習が必要 |
| ログ | 起動ターミナルとartifactsの検査結果 | NodeとStorageの構造化ログを計画 | 左記に認証・EPG・変換・端末 | 左記に監査・通知・復旧演習 |

Demoのコピー可能な手順は[Getting Started](getting-started.md)を使用する。ポートを変える場合は次を使う。

```sh
npm run telestra -- demo --port 5174
```

Minimal以降のコマンドを推測して実行しない。原本保存とチューナー連携は[Phase 02](../tasks/PHASE-02.md)、EPGは[Phase 03](../tasks/PHASE-03.md)、実変換・字幕は[Phase 04](../tasks/PHASE-04.md)、本体Web/PWAは[Phase 05](../tasks/PHASE-05.md)、IaCと二次静的配信は[Phase 06](../tasks/PHASE-06.md)で検証する。必要な課金や権限は導入先を選ぶ時点で公式料金・契約条件を確認する。

## 更新・復旧・アンインストール

Demoの更新前にCtrl+Cで終了し、変更履歴を確認する。Gitの作業差分を保存してから更新し、npm ciとgo mod downloadを再実行する。ローカルに未保存の変更がある状態でresetや強制上書きを行わない。

Demoは台帳とStorageをメモリ内だけで扱い、終了すると合成結果を破棄する。再起動で同じfixtureから再構築できる。失敗した場合は[トラブルシューティング](troubleshooting.md)に従う。実予約や実録画の復旧機能ではない。

アンインストールはサーバーを終了し、自分が取得したcheckoutをファイル管理画面から削除する。変更したファイルと検証結果が必要なら先に退避する。Demoはクラウド資源、Service Worker、常駐サービスを作らない。npm/Goの共有キャッシュを削除する必要はない。

Minimal以降の更新・復旧・削除は未実装である。資源台帳、Retention、バックアップ、権限、復元試験、削除計画を先に揃える。原本を消すコマンド、terraform destroy、無承認のdeployを導入手順へ含めない。

## 外部へ公開しないもの

Demo、Mirakurun/mirakcの管理API、Node join/rotate/revoke、管理用commands、D1管理、Storage管理・一覧をインターネットへそのまま公開しない。Demoは127.0.0.1固定で、Host/Originと要求のサイズを制限する。本体用の認証済み公開APIの代わりにはならない。
