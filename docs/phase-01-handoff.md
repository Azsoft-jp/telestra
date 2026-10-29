# Phase 01への引き継ぎ

この文書はPhase 00の成果から次の作業を具体化した引き継ぎである。最初の依頼はPhase 00限定だった。その後の継続実装指示に基づき、現在はPhase 01のローカル認証・D1永続化・DOの接続制御・Goの再接続Runnerを実装している。採用範囲は[ADR-013](architecture/decisions/ADR-013-phase01-local-auth.md)と[ADR-014](architecture/decisions/ADR-014-local-control-channel.md)、検証結果と残作業は[現在の実装状況](phase-01-progress.md)を参照する。本番・実機への接続、課金資源の作成、本番の秘密鍵の取得・配布は含めない。

## 引き継ぐ実装

[Phase 00の検証報告](phase-00-report.md)では、Mockによる`CORE-01/02`と`MED-01`、受け入れ判定器の自己試験を確認した。現在の`MockActor`と`MockGrant`は呼出元が作れるテスト用の文脈であり、認証情報として使えない。台帳とStorageもメモリ内の実装である。

Node接続や認証を追加しても、原本チャンク、架空の字幕・音声付随情報、再生用派生物の保存先を分ける契約を維持する。Mockの`playable:false`を実Codec対応の証拠にはしない。

## 決定済みの前提と未確定の選択

| 対象 | 既存文書が定める前提 | 実装前に具体化すること |
| --- | --- | --- |
| Provider | Cloudflare第一実装。DOは接続調整、永続Storeが予約・録画情報の正本 | D1のテーブル、条件付き更新、移行・復元手順 |
| 利用者 | 単一家庭から開始。OIDC + PKCE、短命Access Tokenはメモリのみ | issuer、audience、許可Origin、subjectと家庭・Roleの対応 |
| Node | Device identityと短命Credential。BrowserとNodeのCredentialを分ける | 登録主体、joinの有効期間、鍵の保管先、rotate/revoke、接続切断 |
| Role | 利用者はviewer/recorder/operator/adminを想定 | 操作ごとの最小権限、tuner/encoderの機能制限、録画所有者の照合 |
| Control | 型付き制御専用。媒体転送と分離し、Shell等の汎用操作を持たせない | 正式payload、署名対象、Replay記録、sessionEpoch、ACKの規則 |
| 署名 | 現行Capture Permit SchemaにEd25519の記載がある。暗号処理は未実装 | JSON正規化、署名対象、tenant/environment/generation/captureScopeの拘束、鍵選択と失効 |
| オフライン | 確定予約の有限な実行範囲を設け、物理exactly-onceを保証しない | 失効中の既発行Permit、期限・世代、再接続時の照合 |

各項目の差異と質問候補は[ADR-012](architecture/decisions/ADR-012-contract-discrepancies.md)にある。特に`messageId/expiresAt`と`commandId/deadline`の関係、Capture Permitの任意の`captureScope`は、既存の契約を暗黙に書き換えずに整理する。

## 小さなパッチに分ける案

| 順序 | 変更と検証の単位 | 対応する受け入れID |
| --- | --- | --- |
| 1 | Identity、主体種別、Role、環境、期限、失効の契約を定義し、BrowserとNodeの混同を拒否する | `CORE-02`, `NODE-01`, `SEC-02` |
| 2 | Cloudflare向けの永続台帳と移行方法を用意し、再起動後も予約intentと録画情報を取得できるか確認する | `NODE-02`の永続状態部分 |
| 3 | join/issue/rotate/revokeと署名検証を実装し、偽造・期限切れ・失効・別環境を拒否する | `NODE-01`, `SEC-02` |
| 4 | DOの接続RegistryとNodeの再接続を追加し、世代、Replay、上限、backpressureを検証する | `NODE-02`, `SEC-03` |
| 5 | Mock IdPを使って利用者の認証・認可、Origin、CSRF対策を検証する | `SEC-01`, `SEC-04` |
| 6 | Nodeと利用者の認可を縦方向のMock検証へ接続し、Phase 00の原本保存・模擬変換を回帰検証する | `CORE-01/02`, `MED-01` |

この表は実装済みや合格済みを示さない。Phase 01の完了には[tasks/PHASE-01.md](../tasks/PHASE-01.md)と[受け入れ基準](08-acceptance.md)の照合が必要である。ローカルの関数試験、Cloudflareのエミュレーション、実環境のWSS接続を別々に記録する。

## ローカルで検証する境界

署名検証は、許可されたテスト専用の鍵と合成データを使い、本番の鍵を読み出さずに検証する。鍵やTokenをログと証跡へ出力しない。テスト用の署名検証器で代用する場合は暗号検証の合格とは呼ばない。使用するライブラリとCloudflare実行環境の対応も実装時に確認する。

再接続と失効は、模擬時計、接続の切断、期限・世代の更新、キュー飽和を注入して検証する。接続が失われても予約intentと録画台帳を消さず、旧世代が公開状態を変更できないことを確認する。単一プロセスのMapによる比較だけでは、D1の永続化やDO再起動の検証を完了としない。

Mock IdPでは、許可されたissuer/audience/subjectを与える正常系と、別家庭・別所有者・権限不足・期限切れ・失効・不正Originの拒否を用意する。サーバーが認可した主体を現在のAPIへ渡すようにし、リクエスト本文からRoleや所有者を受け取って信頼しない。

## 未確認のまま残す項目

実チューナー、実放送、実Codec、ARIB、PWA、二重静的配信、実IdP、実クラウドへのデプロイは、この引き継ぎ文書では実施していない。ローカルでの検証が成功しても、実環境WSS、IdP連携、D1・DOの障害時挙動、運用上の失効反映は別途確認する。
