# Telestraの開発を始める

Demoを動かしたい場合は[Getting Started](docs/getting-started.md)、開発する場合は[AGENTS.md](AGENTS.md)、[設計レビュー](docs/00-design-review.md)、対象Phaseを読む。ここにある設計を動作保証とは扱わない。

最初のPhase 00ではチューナー不要のMock、原本チャンク、Fake Storage、模擬変換、契約試験を検証した。現在はPhase 01のローカル認証・WSSを継続している。[実装状況](docs/phase-01-progress.md)を確認し、未実装の実録画・視聴・PWAを完成済みと解釈しない。

名称・導入・公開整備は[PROJECT-01](tasks/PROJECT-01-PUBLIC-READINESS.md)で本体と独立して追跡する。次のPhaseへ進む際も、契約、正常・障害・境界値の検証、文書の順に小さな差分へ分ける。本番変更、秘密値取得、課金資源、破壊的操作は自動実行しない。

## 作業フェーズ

| Phase | 成果 | 人による確認 |
| --- | --- | --- |
| 00 | Repo/Contracts/Mock/テスト基盤 | 用語・境界・品質ゲート |
| 01 | Node Registry / 認証 / 接続 | 失効・なりすまし |
| 02 | TunerNode / 原本チャンク / 復旧 | 通信断・二重attempt |
| 03 | EPG / 予約 / 競合 | 延長・再編成・切断 |
| 04 | EncodeNode / 字幕 / 再生 | ARIB・時刻・ブラウザ |
| 05 | WebApp / PWA / 端末保存 | モバイル・オフライン |
| 06 | IaC / ステージング / フロント二重化 | 二重配信・障害注入 |
| 07 | セキュリティ・DR/運用ゲート | 復旧演習・脅威試験 |

各Phaseは前Phaseの合格条件を満たしてから着手する。並行実装する場合も契約とテストを先に固定する。

## いきなり依頼しないこと

- 「全部作って」「企業レベルで完成させて」だけで実装を開始しない。
- 本番Cloudflare/Terraform `apply`、秘密鍵作成と配布、データ削除をCodexへ黙認させない。
- TSをHLSに直接並べる、DRM未検証で配信可能と宣言する、端末オフライン保存が消えないと保証する。
- UIの見栄えだけでDoDを完了にしない。

## 最初に決める最少事項

| 決定 | 推奨デフォルト |
| --- | --- |
| 対象OS | TunerNode: Linux x86_64/arm64; EncodeNode: Linux |
| ユーザー範囲 | 個人/家庭利用の単一テナントから開始。マルチテナントは別設計レビュー |
| EPG | Mirakurun/mirakcの既存Program API優先 |
| Live | まず録画＋事後Encode。ライブを次の縦スライスで追加 |
| Primary Storage | ローカルMock → R2; 予備先はS3Adapter |
| Frontend DR | primary CF静的配信 + secondary独立ドメイン/静的配信 |
| 本番デプロイ | 自動実行しない。レビュー・承認付きで導入 |

## 確認コマンド

Python 3.11+がある環境で、展開したディレクトリから以下を実行する。

```sh
python3 scripts/validate_package.py
```

これはJSON例・ローカル相対リンク・Phase番号などの配布物整合性を確認するだけで、ネットワークアクセスや本番変更はしない。
