# 公開コードと検証環境のリポジトリ

公開側は[Azsoft-jp/telestra](https://github.com/Azsoft-jp/telestra)、非公開側はAzsoft-jp/telestra-deploymentとする。2026年10月29日にGitHub APIで所有者がUserであることを確認した。ユーザーの回答でOrganization指定を個人アカウントへ変更した。両リポジトリを作成し、PUBLIC/PRIVATEと管理・push権限を確認した。確認前の404は、不存在と権限不足を区別できる証拠として扱わなかった。

| 置き場所 | 含めるもの | 含めないもの |
| --- | --- | --- |
| PUBLIC | 汎用コード、設計、合成fixture、公開可能な例、再利用テンプレート、CI | 実環境の識別情報、秘密値、実録画、未伏字ログ、State |
| PRIVATE | 検証環境の非秘密設定、承認条件、公開側の固定SHA、環境別手順 | Token、秘密鍵、証明書の秘密部、State、実録画 |
| Secrets等 | 短命資格、対象を限定した資格、失効・ローテーション | ソース、Issue、PR本文、CI artifactへの転記 |

依存はPRIVATEからPUBLICへの一方向とする。PRIVATEのsource.lock.jsonに公開リポジトリと40桁のcommit SHAを記録し、デプロイ用checkoutはそのSHAだけを取得する。ブランチの最新値を自動追従しない。公開側はPRIVATEをcloneせず、private URLや環境IDをビルドへ埋め込まない。

検証中に見つかったコード修正は、環境情報を取り除いた再現fixtureとともに公開側のPRへ戻す。修正を取り込んだ公開SHAを確認してからPRIVATEの参照を更新する。秘密値が見つかった場合は[SECURITY.md](../../SECURITY.md)に従う。

リポジトリの可視性変更、削除、実デプロイ、保護ルールの緩和は通常のコード更新と区別し、ユーザーの明示的な指示を必要とする。現在のCIはapply/deployを実行しない。利用プランで保護環境が使えるかは、実デプロイの開始前に確認する。
