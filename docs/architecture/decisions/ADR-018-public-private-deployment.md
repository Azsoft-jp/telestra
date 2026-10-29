# ADR-018 公開側と環境側の一方向運用

状態は採用。所有者、MIT、リポジトリ作成はユーザーが明示した。Organization指定は実際のUser種別と矛盾したため、ユーザー回答で個人アカウントへ変更した。

## 選択と理由

PUBLICは汎用コード・設計・サンプル・CI、PRIVATEは検証環境の非秘密設定と公開側の固定SHAを持つ。PUBLICはPRIVATEを参照しない。PRIVATEで修正を抱え込まず、環境情報を除いたfixtureとPRで公開側へ戻す。

Terraformはインフラ、WranglerはWorker bundle・version・deploymentとDO migrationを担当する。既存の所有権表を維持し、同じ設定を二重管理しない。ここで追加するTerraformはfrontend構成の検証用テンプレートで、クラウド資源やbackend DRを作らない。実資源のModule、Provider pin、保護環境と承認付きapply/deployはPhase 06へ残す。

## 代替案とトレードオフ

全設定をPUBLICへ置く案は環境情報の漏えい範囲を広げる。全コードをPRIVATEへ置く案は修正・設計・fixtureの共有を妨げる。ブランチ追従は環境の再現性を失うため、参照をcommit SHAへ固定する。2リポジトリの更新順と参照更新のレビューは運用負荷として残る。

## 見直し条件

実環境の資源と費用、OIDC対応、GitHubプランの保護機能、第二配信先、復元先が決まった段階で導入・復旧のADRを追加する。PRIVATEを秘密の保管先と扱わない。実デプロイを行う場合はユーザーの明示的承認と実行計画を必要とする。
