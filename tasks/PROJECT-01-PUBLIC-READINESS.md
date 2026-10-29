# PROJECT-01 Telestraの名称・導入・公開整備

2026年10月29日の追加指示を追跡する。Phase 01の本体実装と独立して進め、既存コードと検証結果を保持する。本体の残作業は[Phase 01](PHASE-01.md)と[実装状況](../docs/phase-01-progress.md)にある。

## 決定と境界

正式名称はTelestra、CLIはtelestra、npmはtelestraと@telestra/*、環境構成はTELESTRA_*とする。2026年10月29日のユーザー回答により、所有者はOrganizationではなくAzsoft-jpの個人アカウント、本体はMITとする。TunerNode、EncodeNode、StorageAdapter、Webの責務は維持する。既存のv1プロトコル識別子は名称変更だけで破壊しない。

## 実行順序と検収

- [ ] PUB-01 既存構成、ライセンス、公開情報、Git履歴の有無を監査する。
- [ ] PUB-02 名称と環境変数を統一し、契約の互換性をADRへ記録する。
- [ ] PUB-03 README、独自アセット、構成図、実装状況を整備する。
- [ ] PUB-04 Demo UI、導入4モード、設定、成功判定、更新・復旧・削除の案内を整備する。
- [ ] PUB-05 ガバナンス、秘密・依存・ライセンス・Markdown・IaC検査をCIへ導入する。
- [ ] PUB-06 PUBLIC/PRIVATEを実際に確認・作成し、公開側の固定SHAを非公開側から参照する。
- [ ] PUB-07 クリーンなcheckoutでQuick Startを実行し、結果を記録する。

## 公開条件

公開側には汎用コード、合成fixture、設計、CIだけを置く。非公開側にも秘密値を保存しない。実IP、宅内構成、アカウント・資源ID、実録画、未伏字のログを追加しない。公開前に作業ツリーと履歴を検査する。見つかった秘密値をレポートへ転記しない。

## 本体に引き継ぐ作業

Minimal以降の導入、Goからのjoin/rotate、確定予約実行、実Codec/ARIB、PWA、IaC実資源、実環境DRは未実装または未検証である。Demoの成功をこれらの完了とは扱わない。公開レポートは[公開整備の実装結果](../docs/public-readiness-report.md)へ記録する。
