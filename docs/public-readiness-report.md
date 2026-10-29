# Telestra公開整備の実装結果

2026年10月29日のPROJECT-01を記録する。Telestraの名称、導入、公開運用を既存のPhase 00/01へ統合した。本体コードと試験を保持し、実録画・実視聴・PWA・本番デプロイを完成済みとは扱わない。

## 決定と変更

ユーザーの回答により、所有者はOrganizationから実在するUserのAzsoft-jpへ変更し、本体はMITとした。PUBLICの[Azsoft-jp/telestra](https://github.com/Azsoft-jp/telestra)とPRIVATEのtelestra-deploymentを作成し、可視性と管理・push権限をAPIで確認した。公開側には汎用コード・設計・合成fixture・CIだけを置く。PRIVATEにも秘密値は置かず、公開側の固定SHAと未設定の3環境を保持する。

CLIはtelestra、npmはtelestraと@telestra/*、Go moduleはgithub.com/Azsoft-jp/telestra、構成はTELESTRA_*へ統一した。npm run mockは維持する。JWTの用途・audience、X-TV-Device-Proof、Schema ID、v1 wire形式と履歴形式は互換性のため変更していない。npmは未公開で、名前の将来の確保を保証しない。

README、初心者向け4ガイド、構成・原則・ADR、MIT、Contributing、行動規範、Security、Support、変更履歴、Issue/PRテンプレート、実在するCODEOWNERS、Dependabotを追加した。ADRの正本をarchitecture/decisionsへ移し、旧リンクを案内として残した。独自SVGのロゴ案・アイコン・OG案・説明用モックを制作し、第三者の放送画面やロゴは使っていない。Releaseは未作成のためバッジを掲示していない。

## 導入と機能の検証

PUBLICから新しいcheckoutを取得し、既存のnode_modulesやアプリ状態を使わずnpm ci、go mod download、CLI Mock、一括検査を実行した。OSと共有のnpm/Goキャッシュは共用しており、新規VMやコンテナの試験ではない。確認環境はmacOS arm64、Node.js 24.22.1、Go 1.26.10、Python 3.14.8。コード修正commit 372946fを基準に検証した。

| コマンド・対象 | 結果 | 範囲 |
| --- | --- | --- |
| npm ci --ignore-scripts --no-audit --no-fund | 成功 | 新しい依存物配置。実サービスの資格を使わない |
| go mod download | 成功 | go.mod/go.sumの固定依存 |
| npm run telestra -- mock | 成功 | 2,444バイト、4チャンク、playable:false |
| npm run check | 成功 | Phase 00等の16試験、Phase 01の22試験、Go race、型・静的検査、契約・公開情報検査 |
| DemoのHTTP・CLI試験 | 成功 | 固定loopback、合成結果、Host/Origin拒否、読取専用、本文サイズ・パスの拒否、終了 |
| Demoのブラウザ確認 | 一部確認 | 1280pxと320pxで横はみ出しなし、非角丸、合成値表示。WCAG全項目や全端末の合格ではない |
| Terraform 1.17.1 | 成功 | fmt/init/validate、構成契約の3試験とplan。資源0、applyなし |
| Linux arm64 | コンパイル成功 | Go 1.26.10のcontrol試験バイナリ。arm64実行は未実施 |
| GitHub Actions | 成功 | [修正PRのCI](https://github.com/Azsoft-jp/telestra/actions/runs/40812657170)でcheck/security/iacを確認。Linux amd64の実行を含む |
| PRIVATEの検査 | 成功 | 固定SHAとconfigured:falseの3環境を検査し、公開commitを取得。公開コードをPRIVATE権限で実行しない |

クリーンcheckoutの最初の検査では、DependabotがGit履歴に付ける公開サービス用メールを私的メールとして検出して失敗した。履歴メタデータに限ってGitHubのnoreply/supportを区別し、通常メールと作業ツリーの検査を維持する修正を[PR #9](https://github.com/Azsoft-jp/telestra/pull/9)で検証した。PRIVATEの最初の配置ではSHA参照元の取り違えで参照ファイルが欠けた。失敗を残したまま、参照を明示した修正commitで設定・取得・CIを再確認した。

## スキャンと依存修正

| 検査 | 確認した結果と限界 |
| --- | --- |
| Gitleaks 8.30.1 | 作業ツリーと全参照のGit履歴で検出0。値はredactし、秘密の本文を証跡へ出さない |
| 公開情報の独自検査 | 禁止パス、秘密の型、私的IP、Host、識別情報、メールを検査。Git blobとメタデータも検査。未知のPIIを全て識別する検査ではない |
| npm audit | 当初4依存物に検出。fast-uri 3.1.9、sharp 0.35.5、undici 7.30.1へ固定し、再検査は0件 |
| govulncheck | Go 1.26.8の標準ライブラリで到達可能な10件を検出。公式SHA-256を照合したGo 1.26.10で再検査し、No vulnerabilities foundを確認 |
| ライセンス | npm 98件のSPDX申告とGo websocketのISCを確認。本体MITと第三者の条件を分離。LGPLを含む配布条件の個別確認は実成果物の配布前にも必要 |
| Markdown | ローカル参照の存在を検査。外部サービスの将来の到達性は保証しない |

GoのJSON検査の終了コードだけを合否に使わず、通常出力の終了コードも確認した。既存の端末全体のGoは変更していない。今回の検証用パスとCIはGo 1.26.10を使う。秘密値漏えいを示す検出はなく、本番資格の取得・ローテーションは行っていない。検出0を、未知の秘密や個人情報が絶対にない証明とは扱わない。

文書と日本語コメントはyomiyasuの静的検査と差分確認を行った。正本のように設計上の意味を持つ語や、適用範囲を区別する否定は維持した。検査と確認用テキストはローカルのartifactsへ保存し、Gitへ含めない。

## 未実装・未検証と次の入力

Demo以外のMinimal/Recommended/Production、実チューナー、実録画、実Codec/ARIB、PWA、端末保存、実環境IaCとDRは未実装または未検証である。Docker daemonが動いていなかったためComposeは提供・検証していない。ロゴは案で、商標確認、OGのPNG化、SNS実機表示、安定版Releaseも未実施である。

Terraformはフロント構成の検証テンプレートだけで、Cloudflare/AWSの実資源Moduleを検証したものではない。apply/deploy workflowは置いていない。実導入にはProvider/Wranglerの固定、保護環境と承認、GitHubプラン、OIDC経路、費用、監視、バックアップ・復元・rollbackの確認が必要になる。

本体の次の作業はGoからのjoin/rotateと資格更新失敗時の復旧である。実機検証にはMirakurun/mirakcの版、OSとチューナー、回線・容量、権利を持つgolden fixture、視聴端末、IdPと鍵の保管方法が必要になる。実資源ID等の環境情報はPRIVATEへ、秘密はSecrets/OIDC等へ分ける。frontend dual-staticをAPI・認証・DBの全面冗長化と解釈しない。

## 変更ファイル

PUBLICの200ファイルを初期配置した。添付ZIPとの差分は[変更一覧](implementation-files.md)に記録する。README、docs/architecture、導入4ガイド、ガバナンス、CI、Demo、CLI、名前・構成参照、公開前検査が今回の主な対象である。PRIVATEはREADME、固定SHA、未設定の3環境、検査スクリプトとCIを別に管理する。
