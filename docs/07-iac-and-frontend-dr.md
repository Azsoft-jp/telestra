# 07 / Terraform、Wrangler、フロント簡易冗長

## 基本方針

Terraform/OpenTofuはインフラリソース、WranglerはWorkerのビルド/デプロイ、GitHub Actions等のCIがテスト・承認を担当。**同じ設定を2つのツールで更新しない**。最新のCloudflare Terraform Provider/WranglerのAPIは着手時に公式Docsへ照合してversion pin。

## 所有権テーブル（設計上の配置）

| 対象 | Owner | 注意 |
| --- | --- | --- |
| DNS、R2、D1、Queues、Access/WAF/Rate | Terraform/OpenTofu | staging/prod別State |
| Worker名/Route/Custom Domain | Terraformを原則 | 初回資源作成/参照名を出力 |
| Worker bundleと静的アセット | Wrangler/CI | deterministic build digest |
| Worker version、deployment、rollout | Wrangler/CI | 単独管理、Terraformからdeploymentを同時管理しない |
| Durable Object class/Binding/マイグレーション | Wranglerで一体管理を初期推奨 | 初期deploy順と旧class互換に注意 |
| CI secrets/OIDC | CI/Secret Manager | Stateやソースに値を置かない |
| データベースschema migrations | アプリ専用移行ジョブ | expand→deploy→contract、手動承認 |
| Static secondary | Terraform AWS module + 同じCI artifact | 初期はAWS S3（private）+ CloudFront OAC |

Cloudflare公式文書にはTerraformのみでWorker version等を扱う構成もあるが、Durable Object初回migration/Binding依存がある。上表は初期運用の簡潔性を優先した選択であり、Providerの将来変更に応じてADRで見直す。

## フロント冗長化 — 簡単さを優先

`frontend.redundancy`を`none`/`dual-static`の2値で設定する。

- `none`: Cloudflare Workers Static Assets単系。
- `dual-static`: 同一Viteビルドの`dist`（hash固定）を **Cloudflare Primary** と **AWS S3 private + CloudFront OAC Secondary** に配備。
- Secondaryは別DNSゾーン/レジストラ管理ドメインを候補にし、Cloudflare DNS/IdP/APIが落ちても少なくとも静的サイトが独立配信できるようにする。
- ただしバックエンドはCF-firstであり、secondary UIが起動してもEPG/予約/認証が利用不能な場合がある。「Front DR」と「Full DR」を別SLOで監視する。
- 同一canonical originの自動切替は、DNS/証明書/キャッシュ/Cloudflareルーティング/IdP/cookie/SWを跨ぐ複雑な構成。v0.1には入れない。

## 静的ファイルの整合性・切替

1. CIで一度だけfrontendをbuildし、`buildId`とSHA-256を記録。
2. PrimaryとSecondaryに同じ`dist`を配信し、`/.well-known/build.json`等でhash/commitを照合。
3. JS/CSSはcontent hash filename +長期immutable cache、`index.html`は短いcache／更新確認。
4. SPAの未知パスは`index.html`へfallback。APIリクエストと混同しない。
5. Primary/SecondaryそれぞれOIDC+PKCEのredirect URIを登録し、APIはBearer+CORS Origin allowlistでアクセス可能にする。Tokenはメモリのみ。別originで既存セッションを持ち越さず新規ログイン。ブラウザとIdPの実機E2Eが必須。Service Workerはoriginごとに独立。
6. 定期的に手動/自動の切替演習。Primary障害時にCF Workerによるredirectだけを頼らず、別チャネルでbackup URLを知らせる。
7. UIのpublic bootstrap設定は認証情報を含まず、backend origin/version/feature flagsのみ。API到達不可能時でもオフラインページを表示。

### 将来のフルDR

- Control Plane/DB/Job状態の第二実装と、IdPの独立性・復旧資格を持つ。
- Storage Replicaに必要なオブジェクト、メタデータ、権限の同期を含める。
- キャプチャのoffline予約実行と復旧時のreconciliationを別環境へ再接続できるようにする。
- DRを実装・訓練していない状態で「全サービス自動フェイルオーバー」と表示しない。

## 環境構成

- `development`: Mock Tuner + Local Storage + local Workers emulation。データとsecretを本番と隔離。
- `staging`: Cloudflare実リソース、最小課金/短期Retention、合成fixture。データは本番と非共有。
- `production`: 別State、保護環境、承認付きapply/deploy、監査と通知。

Terraform Stateは暗号化とRBAC付きのremote backendに保存し、PRでplanを表示。本番applyは人の承認。CIは短命OIDCの権限を用い、destroy権限を日常ジョブから分離。

## 本番で必要なリリース工程

1. lockfile/SBOM/依存脆弱性/秘密情報検査
2. unit + schema contract + integration + PWA E2E
3. terraform fmt/validate/plan （applyしない）
4. staging IaC apply/DB expand migration/Worker deploy
5. staging healthcheck、EPG/Storage/Node+security negative tests
6. 同一distをPrimary+Secondaryへ配備しdigest一致
7. 本番承認→canary/段階deploy→監視→rollback
8. データ移行はコードrollbackでは元に戻らない。DBは後方互換を維持

## IaCの最初の納品物

- 各Providerのrequired versionと`terraform validate`の通る**最少モジュール**（ネット接続/実資格がなければ`validate`可否を区別）。
- Worker/Bindings/DO migrationの所有権と初回deploy手順を`ops/`に記載。
- `frontend.redundancy`の`none`と`dual-static`に対するplan差分・費用概算。
- secretなしでも実行できる`dry-run`/`build`のCI。
- `drill:frontend-primary-down`のテスト手順。

## 公開側と検証環境の配置

[公開・非公開の運用](governance/repositories.md)に従い、PUBLICへ汎用Module/テンプレート、PRIVATEへ固定SHAと環境固有の非秘密設定を置く。秘密値はどちらにも保存しない。TerraformのPR検査はfmt/validate/planを行い、apply/deployは保護環境と明示的承認を要する。CloudflareのOIDC対応は経路ごとに検証し、短命資格を優先する。

現在の[frontend-contract](../ops/terraform/README.md)は資源を作らない構成検証用である。Cloudflare Provider、Wrangler、R2等の実資源Moduleを検証したものではない。実資源のversion pinと初回移行はPhase 06に残る。所有権の分離は[Cloudflareの公式方針](https://developers.cloudflare.com/terraform/advanced-topics/best-practices/)も参照する。
