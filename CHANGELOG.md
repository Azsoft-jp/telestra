# 変更履歴

## Unreleased

Telestraへ名称を統一し、CLI、npmパッケージ、Go import、TELESTRA_構成を整理する。MITを採用し、Azsoft-jpのPUBLIC/PRIVATE運用、導入4モード、README、ガバナンス、公開前検査を追加する。Demoは合成結果を表示するローカル専用UIで、実放送や映像再生を含まない。

Phase 00ではMock Tuner、原本チャンク、Fake Storage、模擬変換、契約試験を追加した。Phase 01ではローカルWorker/D1/DOの認証とGoの署名付きWSS、再接続、永続履歴を実装した。本体の残作業と検証範囲は[実装状況](docs/phase-01-progress.md)にある。

Goのjoin/rotateをローカルWorkerへ接続し、新資格でのWSS接続、応答喪失時の旧資格の隔離、管理者による再参加を追加した。

Lifecycleで接続中の期限前更新とWSS再接続を追加した。旧接続を回収してから更新し、障害の再試行枠とbackoffを引き継ぐ。本番の鍵保管・再起動復旧・長時間運転は未検証である。

履歴v2へ非秘密の資格確認情報を追加した。再読込後は最後の資格だけを照合し、更新途中・別鍵・旧Clientを拒否する。v1の命令履歴は保持する。本番の秘密値保管Providerは未実装である。

JWT用途、Schema ID、v1のwire形式と永続履歴は名称変更でも維持する。旧npm名・Go import・内部環境変数は未公開の開発用であり、新しい名称を使う。既存のnpm run mockは継続する。安定版Releaseはまだ作成していない。
