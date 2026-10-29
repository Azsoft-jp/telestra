# 10 / 一次資料と再検証ポイント

確認基準日: 2026-10-29。外部プロダクトの仕様・料金・Quota・互換性は変更され得るため、Codex実装着手時に必ず公式文書を再確認する。以下は設計の参考情報で、特定バージョンで実機検証済みという意味ではない。

## Codex

- [AGENTS.md project instructions — OpenAI official](https://learn.chatgpt.com/docs/agent-configuration/agents-md) — `AGENTS.md`の探索階層とサイズ上限。

## CloudflareとIaC

- [Workers IaC](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/) — TerraformとWranglerの所有権、DO migration初回依存。
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) — SPAの404 fallback、assetとWorker配信。
- [Workers Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/) — dev/staging/prod分離。
- [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — Hibernationと接続管理。
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) — at-least-once。
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) — 書込primary/読取複製、Sessions。
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) — DBの復旧。
- [R2 upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/) — 単一PUT/Multipart制限。
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) — Storage/read/write/retrieval/egress。
- [Cloudflare Stream Live requirements](https://developers.cloudflare.com/stream/stream-live/start-stream-live/) — H.264/AACなど。生地デジTSのそのまま入力を前提にしない。

## フロント・セキュリティ

- [SAP Fundamental Styles](https://github.com/SAP/fundamental-styles) — UI基盤、独自トークンのoverride検証。
- [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) — WSS、Origin、CSWSH、メッセージ認可。
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) — Security acceptanceの基準。
- [AWS CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html) — static secondaryをprivate S3で配信する場合。
- [Yomiyasu](https://github.com/nanaism/yomiyasu) — 日本語推敲思想の参照。外部Skillは本ZIPにインストール/再配布していない。

## Mirakurun/KonomiTV/メディア

- [Mirakurun API](https://github.com/Chinachu/Mirakurun/blob/master/api.yml) — Program等のAPI契約確認。
- [mirakc Web API](https://github.com/mirakc/mirakc/blob/main/docs/web-api.md) — Mirakurun互換・差異。
- [KonomiTV](https://github.com/tsukumijima/KonomiTV) — 参考実装。APIやUIの同一性は初期目標ではない。
- [KonomiTV Releases](https://github.com/tsukumijima/KonomiTV/releases) — 再生方式と字幕sidecarの更新履歴。
- [mpegts.js](https://github.com/xqq/mpegts.js) — 対応/非対応codecsの確認。
- [aribb24.js](https://github.com/monyone/aribb24.js) — ARIB字幕描画候補。
- [tsreadex](https://github.com/xtne6f/tsreadex) — TSと字幕の処理候補。
- [b24tovtt](https://github.com/xtne6f/b24tovtt) — ARIB情報を特殊cueへ保つWebVTT方式の候補。
- [RFC 8216 HLS](https://www.rfc-editor.org/rfc/rfc8216) — セグメント、時刻、discontinuity。

## 追加検証

- KonomiTVや字幕ライブラリのライセンス（バイナリ依存物まで）、配布義務。
- iOS/Safari/AndroidのPWA/OPFS/background downloadのサポート状況。
- 次世代Cloudflare Provider/WranglerでのDO migration/API契約。
- 複数Storageの料金/容量/リクエスト/外向き通信。
- 実機Mirakurun/mirakcのEIT/Programs取得差と録画時のサービスフィルタ設定。
