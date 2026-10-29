# Phase 05 — Responsive UI / PWA / Device Save

## 実装

1. SAP Fundamental Styles + アプリデザイントークン。非角丸、PC/Tablet/Mobile/TV、keyboard/スクリーンリーダー。
2. Home、EPG、Live、Recordings、Offline、Settings。主要操作は常に明確。
3. ワークフロー: 初回ペアリング、番組予約/競合、録画結果、変換待ち、字幕/音声切替。
4. PWA manifest、Service Workerによるアプリシェルのオフライン。APIレスポンス・秘密値の無制限cache禁止。
5. 前景・チャンクDL、ETag/hash、再開、OPFS/保存容量のfeature detect。ファイル書出は別フロー。
6. ARIB字幕sidecarと必要資源を含むoffline package。オフライン再起動で再生確認。
7. 日本語文言レビュー。Yomiyasuは外部依存として任意、同梱しない。
8. 二重フロントはOIDC+PKCEの独立ログイン、短命Tokenのメモリ保持、APIのOrigin allowlistで動作を検証。TokenをlocalStorageへ置かない。

## 完了条件

- `UX-01`〜`UX-10`, `MED-10`, `SEC-09`の自動/手動E2E。
- 通信断・ストレージ不足・API停止の状態を読み分けられる。
- 320pxと大画面のタッチ/キーボード操作が可能。
- PWAを常時バックグラウンド録画システムと扱わない。
