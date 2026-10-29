# Codexレビュー依頼（コピペ用）

この変更を、`AGENTS.md`と`docs/08-acceptance.md`に基づき、厳密にレビューしてください。修正より先に読取・診断を行い、重大度順に「実際に壊れる経路」「影響」「再現条件」「最小修正案」を示してください。

特に以下を確認してください。

1. Captureのsplit-brain/重複attempt、古いLeaseからのpublish。
2. 原本TSとHLS renditionの取り違え、ARIB字幕/音声/PTS連続性。
3. Authorization/tenant IDOR、WS Origin/nonce/expiry、任意URL/FFmpeg command injection。
4. EPG延長/ID再利用/予約変更、通信断中の確定予約。
5. PWA容量/オフライン/別origin分離と、フロント単独DR誤表示。
6. TerraformとWranglerの設定二重所有、Secret/State漏洩。

テストしていない箇所は「未実行」と明記し、変更・デプロイ・削除を勝手に行わずレビューを返してください。
