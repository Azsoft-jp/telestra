# Phase 07 — Operational Hardening / Security / DR

## 実装

1. テレメトリ（捕捉/ドロップ/EPG freshness/Encode latency/replica lag/エラー/再生）と通知。
2. Secret rotation、Node revoke、Audit retention、RBACレビュー、FFmpeg sandbox、CSP/CSWSH/SSRF負荷試験。
3. DB Time Travel + 独立backup export、録画manifest/Storage replica復元演習。
4. Node offline/DB failure/R2 failure/Front primary failure/IdP failure/回線断のgame day。
5. SLOとalert、運用runbook、故障者向けエラーメッセージ。
6. 不完全録画/削除/Retentionの人的レビューと復旧導線。

## 完了条件

- `SEC-01`〜`SEC-10`, `REL-01`〜`REL-10`の結果にevidenceを持つ。
- コスト/課金の監視、ストレージ増加見通し、停止可能なkill switch。
- stagingで復元と障害注入を再現できる。
- 本番安全性を宣言するには未合格/skip項目を解消または明確な残リスクとして承認。
