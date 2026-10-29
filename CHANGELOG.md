# 変更履歴

## Unreleased

Telestraへ名称を統一し、CLI、npmパッケージ、Go import、TELESTRA_構成を整理する。MITを採用し、Azsoft-jpのPUBLIC/PRIVATE運用、導入4モード、README、ガバナンス、公開前検査を追加する。Demoは合成結果を表示するローカル専用UIで、実放送や映像再生を含まない。

Phase 00ではMock Tuner、原本チャンク、Fake Storage、模擬変換、契約試験を追加した。Phase 01ではローカルWorker/D1/DOの認証とGoの署名付きWSS、再接続、永続履歴を実装した。本体の残作業と検証範囲は[実装状況](docs/phase-01-progress.md)にある。

JWT用途、Schema ID、v1のwire形式と永続履歴は名称変更でも維持する。旧npm名・Go import・内部環境変数は未公開の開発用であり、新しい名称を使う。既存のnpm run mockは継続する。安定版Releaseはまだ作成していない。
