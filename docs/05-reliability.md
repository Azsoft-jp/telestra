# 05 / 可用性・フォールバック・災害復旧

## レベルと保証の区別

| レベル | 内容 | デフォルト |
| --- | --- | --- |
| L0 | 1つのTunerNode、1つのEncodeNode、R2。故障は明示 | 開発/個人の低コスト構成 |
| L1 | 複数Tuner/Encode、原本immutable、2nd Storage、front dual-static | 標準的な耐障害運用の目標 |
| L2 | 別Control Plane/DB・IdP/ドメイン復旧経路、定期演習 | 別プロジェクトのDR拡張 |

本パッケージの目標は**L1を段階的に実現できる設計**。L2の自動フェイルオーバーや99.99%を既定で保証しない。

## 障害と期待動作

| 故障 | 動作 | 利用者表示 |
| --- | --- | --- |
| EncodeNode/GPU | 別Nodeで再試行・低画質profile。ライブは新epochで再生再接続し得る | `画質を変更して再接続中` |
| すべてのEncoder不可 | 原本録画を継続。ブラウザ再生は変換待ち | `録画は継続中・再生は準備待ち` |
| TunerNode切断 | 事前確定予約は限定的にローカル実行。必要なら代替Node再割当 | `ノードとの接続を確認中` |
| Node二重録画 | attempt分離・immutable、canonical選定 | `複数録画を確認中` |
| 上り回線断 | ローカルスプールへ。容量超過前にアラート/優先度適用 | `転送待ち（空き容量: ...）` |
| Storage primary障害 | 書き込み禁止しない設計なら許可済みfallback Storageへ新attempt/chunkを記録。後でreconcile | `保存先を切替中` |
| DB primary障害 | 新予約・公開ポインター更新は停止し、Agentの確定予約実行のみ継続 | `予約変更は現在利用できません` |
| Front primary障害 | 独立URLのsecondaryでUI配信（APIは別の要件） | `予備サイトを開く` |
| IdP/API全停止 | 既存PWAのローカル保存済みメディアだけ利用可能な範囲で再生 | `オフライン` |

## 録画の永続化ルール

1. 受信したTS→必要な量のwrite-ahead spool→storageへのchunk upload。
2. 対象objectの長さ/Hashを検証してcommit ACKを受信。
3. AgentはACK済みchunkを設定した保持余裕後に消せる。オブジェクト保全ポリシーに応じて二次ReplicaのACKが必要な運用もある。
4. chunk manifestをversion/epoch条件付きで更新し、`completed`で全chunk/時間範囲検査。
5. 二重録画は試行ごとに分離。`canonical`の選定は信頼できる単一の条件付き更新と監査ログで行う。

ローカル必要量は「最大書込み率 × 許容する断時間 × 同時録画数 + 制御余裕」。例えば20MbpsのTSを2本、30分分ためると約9GB（転送オーバーヘッドなど除外）が必要。**ほぼ0GBという目標ならオフライン耐性は犠牲**にする必要がある。

## 予約・ジョブの整合性

- Queuesはat-least-once、Node messageは重複到着し得る。
- `attemptId`と`jobId`は不変。タスク再試行には新`attemptId`/executionGenerationを付ける。
- Timeout/Lease切れによる再割当時、旧workerのcanonical公開・manifest上書きを防ぐ。
- 一方、旧TunerNodeのオフライン録画はネットワーク分断中に停止できない。物理exactly-onceを主張しない。
- Encode jobは遅延/再実行できる。原本キャプチャはできない区間が生じるので優先。
- リトライは上限・指数backoff+jitter・dead-letter/reconcile・手動再試行の経路を持つ。

## SLOの仮置き（運用で測定して確定）

| 指標 | 初期目標案 | 検証方法 |
| --- | --- | --- |
| Front静的配信 | 99.95%（月次） | 主/予備siteの外形監視 |
| API read成功率 | 99.9%（月次） | API synthetic checks |
| EPG新鮮度 | 収集可能時に15分以内 | source age dashboard |
| 予約の実行遅延 | 開始時刻から±10秒を目標 | 模擬時計+実機 |
| Encode故障検知 | 30秒以内 | process killテスト |
| 事後Encode再割当 | 2分以内 | 連続障害テスト |
| Metadata RPO/RTO | ≤15分 / ≤2時間を初期DR目標 | バックアップ復元演習 |

上記はいずれも**未検証の設計目標**。録画開始の精度はEPG更新/録画backendに依存。Storage primary/secondaryが同一障害ドメインならDRにならない。

## バックアップとDR

- D1 Time Travel/PITRを使い、R2/別アカウント/別プロバイダーへ構成・スキーマ/メタデータの定期エクスポートを検討。
- R2 Object Replication/StorageAdapterは「成功済みレプリカ数、遅延、未複製オブジェクト」を監視する。
- 予備Hostへ静的成果物のみ配置する簡単な冗長と、DB/API/IdPの別系統復旧を混同しない。
- 定期的に「本番資格がなくてもスナップショットから復元し、録画を開ける」演習を行う。

## 注入すべき故障

`REL-01` Node offline予約、`REL-02` 同時二重attempt、`REL-03` 旧Leaseで公開禁止、`REL-04` 途中アップロード・chunk消失、`REL-05` EncodeNode kill、`REL-06` R2 write unavailable、`REL-07` D1 write unavailable、`REL-08` 予備URLでSPAのみ表示、`REL-09` 予備URLからAPI offline、`REL-10` バックアップrestore。
