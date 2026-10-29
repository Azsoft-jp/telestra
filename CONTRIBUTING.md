# Telestraへの貢献

まず[実装状況](docs/phase-01-progress.md)、[設計原則](docs/architecture/principles.md)、[AGENTS.md](AGENTS.md)、対象のtasksを読む。小さな差分で正常系・障害系・境界値を検証し、実装と設計を区別して報告する。現在の追加整備は[PROJECT-01](tasks/PROJECT-01-PUBLIC-READINESS.md)で追跡する。

```sh
npm ci --ignore-scripts --no-audit --no-fund
go mod download
npm run check
npm run public:check
```

手書きコードには日本語コメントを付ける。責務、信頼境界、認可、永続化、再試行、失敗条件を説明し、処理名の言い換えは増やさない。利用できる場合はyomiyasuで日本語を確認する。コード、文書、fixtureは自分が利用権を持つ素材に限る。

PRには目的、変更、実行コマンドと結果、未確認、既知の限界を記す。API、Schema、Token、永続形式の非互換変更はADRと移行手順を先に用意する。実行していない検査を合格と書かない。本番デプロイ、課金資源作成、削除、秘密値取得をPRの試験へ含めない。

実IP、個人ドメイン、宅内構成、識別子、秘密値、実番組履歴をIssueやPRへ貼らない。PRIVATEで見つけた修正は、環境情報を除いた合成fixtureで公開側へ提案する。依存更新と互換性の扱いは[方針](docs/governance/releases.md)に従う。

貢献する内容は、自分が提供する権利を持ち、プロジェクトのMITで提供できるものに限る。第三者コードは由来、版、SPDXと必要な表示を添える。CLAや架空の企業所属を前提にしない。
