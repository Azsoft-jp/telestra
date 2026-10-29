# 04 / セキュリティ・脅威モデル

これは設計目標であり、SOC2やISO27001の認証取得済みを意味しない。基準はOWASP ASVS v5系とWebSocket Security Cheat Sheetを参照。実装時点で版を固定してレビューする。

## 信頼境界

1. Public Browser/PWA（信用しない）
2. Public API/Workers/Playback Gateway（認証・認可・入力検証）
3. Control Plane persistent state（予約とrecording台帳の正本）
4. Agent Control Channel（Node ID、証明書/資格、受信コマンド限定）
5. Tuner Backend/FFmpeg（半信頼の外部入力・sandbox）
6. Private Object Storage（鍵・policy管理）
7. CI/CD/IaC/Secrets（本番デプロイ権限）
8. Alternate static frontend（UIのみの別origin）

## 認証・認可

| 主体 | 認証 | 認可 |
| --- | --- | --- |
| 人間 | OIDC Authorization Code + PKCE、MFA/PasskeyはIdP側policy | `viewer`, `recorder`, `operator`, `admin`。初期は単一テナント |
| PWA API（初期の二重配信互換方式） | OIDC Authorization Code + PKCE、短命Access Tokenをメモリだけに保持。Refresh Tokenの永続保存なし | APIのBearer認可とCORSのOrigin allowlist。token権限・audience・issuerを検証 |
| 予備origin PWA | 同じIdPへ新たにログイン。別originに既存tokenを移送しない | APIで明示allowlistしたOrigin。ブラウザごとに実機検証 |
| TunerNode | device identity＋短命認証/証明書、ローテーション | 指定チャンネル/サービス/時刻/対象Storage prefixに制限 |
| EncodeNode | device identity＋短命認証、作業単位lease | 読取対象原本と書込prefix/プロファイルだけ |
| CI/CD | OIDC連携・短命クラウド権限 | staging/prod分離、prod承認 |

### Browserセッション方式の選択理由と残リスク

異なる登録ドメインのPrimary/SecondaryでCookieを共有しようとすると、SameSite/第三者Cookie制限に左右される。そこで初期の`dual-static`は、両originで同じOIDC+PKCE public-clientフローを使い、Access Tokenをメモリだけに保持する設計を推奨する。XSSで一時Tokenが盗まれる残リスクがあるため、短命token・CSP・最小scope・厳格な認可・再ログインを採用する。**本番の機密性要件が強ければ、各originにBFFを置いてHttpOnly sessionへ移行するADRを別途評価する。** これは設計案であって完成した認証実装ではない。

## WebSocket

- すべてWSS。本番で平文`ws://`を使わない。
- Browserの接続時に`Origin`を完全一致allowlistし、Session/CSRF対策。非ブラウザAgentはOriginの代わりに資格・署名・NodeIDを必須。
- handshakeとコマンドごとに認可、発行時刻/expiry/nonce/idempotency/sessionEpochを検証。資格失効時の接続切断。
- 1メッセージのサイズ/頻度、接続数、操作rate、滞留キュー、backpressureに上限。
- メッセージ名はallowlist。汎用Shell、外部任意URLのfetch、任意パス書込は設けない。
- ログは`requestId`, `nodeId`, `action`, `decision`, `timestamp`, `traceId`、必要ならpayload hashのみ。Cookie、credential、生TS、視聴履歴は記録しない。
- 拒否テスト: 偽造Node、他人のrecordingId、他environment、expired/replayed command、oversize、CSWSH、token revocation。

## 映像の安全な処理

- Media/TS/metadataは悪意のあるバイト列として扱い、FFmpeg等はroot権限なし、リソース制限、ネットワーク/ファイルシステムアクセス制限下で起動。
- inputはユーザー指定の任意URL/パスではなく、認可済みobjectId/recordingIdからサーバー側で解決。処理できるprotocol allowlist。
- Encoder引数は構造化フィールドから構築し、ユーザー入力をShellとして連結しない。タイムアウト、CPU/GPU/メモリ、同時数を制限。
- 単一ファイルのサイズ/処理時間/解像度/字幕レコード件数に上限。
- Storage: 原則private。短命の署名付きURLまたは認可ゲートウェイ。最小prefix・method・content length・TTLを適用。署名URL流出も危険とみなす。
- R2/B2等のバケットへのクライアント直書込みは禁止（専用短命grantのみ許可）。原本prefixを公開読取可能にしない。
- 二次配信や共有リンクは別の権利・権限レビューを通す。

## PWA/フロント

- CSP、Trusted Types（環境/ブラウザ対応を確認）、XSS防止、SRI/ビルド成果物ハッシュ、HSTS。ユーザー入力のHTML直埋めを避ける。
- Service WorkerはAPIレスポンス・Cookie・署名URL・管理画面の個人データを無制限キャッシュしない。
- Offline Libraryは端末利用者からの秘密保持が保証されない。必要なら端末暗号化/鍵管理の設計を別途行う。
- 別origin secondaryはログインし直す。セッションの無理なクロスドメイン共有やlocalStorage token複製を禁止。
- ユーザー削除はクラウド権限を失効させる。オフライン端末に既に保存済みのデータは即時遠隔消去を保証しない。

## 脅威・検証一覧

| ID | 脅威 | 防御・拒否テスト |
| --- | --- | --- |
| SEC-01 | 他ユーザーの録画取得 | 録画IDだけでは取れない、user/tenant ACL |
| SEC-02 | Node偽装 | Device identity mismatch/失効を拒否 |
| SEC-03 | WSコマンド注入 | Schema/allowlist/nonce/サイズ制限 |
| SEC-04 | WebSocket CSWSH | Origin検証・CSRFとセッション期限 |
| SEC-05 | SSRF/コマンド注入 | 任意URI拒否、Encoder sandbox |
| SEC-06 | Presigned URLの再利用 | 期限・scope・prefix、再利用制限を方式に応じて検証 |
| SEC-07 | CI Secret漏洩 | Secret scanning、State/Artifact監査、ローテーション演習 |
| SEC-08 | 削除/Retentionの誤用 | 権限/二段階確認、grace、復旧 |
| SEC-09 | XSS経由のPWA汚染 | CSP/SWキャッシュ検証、Trusted rendering |
| SEC-10 | ブラウザ/Node DoS | レート/サイズ/容量のquotaと回復検証 |

## 本番運用の最低ライン

- Infrastructure/SBOM/dependency scan、署名とイメージpin、脆弱性修正SLA。
- Auditログの管理者分離、保持期間、改ざん検知。過剰なPII/視聴データ収集は禁止。
- SecretはSecrets Store等で管理しTerraform State・Wrangler configに平文を置かない。ログでの秘匿。
- break-glass手順、credential失効訓練、復旧鍵の二重管理。
- WAFは補助防御であり、アプリ認可の代替ではない。
