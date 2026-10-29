# Phase 02 — Lightweight TunerNode / 原本録画

## 実装

1. Go単一バイナリのTunerNode、Mirakurun/mirakc API Adapterと契約試験。
2. 既存Programs取得とTSストリーム受信/packet sync検証。独自EIT解析やエンコードは入れない。
3. 背圧付きbounded spool。保存可能な最大量とoverflow policyをユーザーが設定可能。
4. raw TSのimmutable chunk PUT、stat/length/hash確認、manifest publish。
5. 再送とidempotency、破損/欠損/重複の検出。
6. `recordingId`配下の複数`attemptId`、canonical選定、offline確定予約、停止確認待ち。
7. StorageAdapter: Local/Fake、R2用、汎用S3用のcapabilityと署名grantの区別。

## 完了条件

- `MED-01/02/11`, `REL-01/02/03/04/06`, `SEC-06`がpassまたは未実機項目が明確にskip。
- ネットワーク断から復帰し、アップロード済みchunkを重複上書きしない。
- ローカル容量と切断耐性の関係をUI/設定/メトリクスに表示。
- 他ノードのrecordingや別tenant prefixへの書込を拒否。
