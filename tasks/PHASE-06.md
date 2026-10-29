# Phase 06 — IaC / Wrangler / Front Dual-static

## 実装

1. Cloudflare Terraform/OpenTofu modulesとversion pin。権限/DB/R2/Queues/DomainのOwnerを文書通り固定。
2. Wrangler config環境分離。Worker bundle/DO migration/rolloutの所有者を統一。
3. ローカル/dev/staging/prodの接続設定を分離し、公開repoへSecretを含めない。
4. 一度だけbuildしたPWA `dist` をCloudflare Workers Static AssetsとAWS S3 private + CloudFront OACへ配布する`dual-static`を選択式で実装。
5. 同一build digestとSPA fallback、API停止時の予備画面、CORS/IdP redirect URI/別origin storageを検証。
6. `terraform plan`のdry-run、stagingだけのapply、productionは手動承認付きプロセス。

## 完了条件

- `REL-08/09`, `UX-09`, `SEC-07`。
- `none`と`dual-static`の二構成を宣言的に比較可能。
- 管理者が「フロントのみ切替」「API/認証も復旧」の境界を理解できる手順。
- 未承認の`terraform apply`, `wrangler deploy --env production`を実行しない。
