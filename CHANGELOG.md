# 変更履歴

## Unreleased

独立したCapture Policy v2のSchema・署名・検証、D1 snapshotのCAS保存と現在値照合、端末証明付きHTTPS取得を追加する。Go・Node.js・workerdの相互試験を行い、policyとPermitのID・世代・発行者を照合する。Nodeの確定保存と実録画は有効にしない。

D1のNode認可世代をCredential世代から分離する。通常rotateで維持し、明示的なjoin・失効で進める。既存DBの追加移行、上限、書込失敗、競合と再起動の合成試験を追加する。署名付きpolicyと実録画は有効にしない。

ユーザーが選択したCapture Permit v2のCompact JWSと認可世代の分離を採用する。専用Schema、Go・TypeScript検証器、Node.js・Go・実workerdの相互試験を追加する。v1の制御命令は維持し、policy永続化とStorage Grantを検証するまで録画実行を有効にしない。

Telestraへ名称を統一し、CLI、npmパッケージ、Go import、TELESTRA_構成を整理する。MITを採用し、Azsoft-jpのPUBLIC/PRIVATE運用、導入4モード、README、ガバナンス、公開前検査を追加する。Demoは合成結果を表示するローカル専用UIで、実放送や映像再生を含まない。

Phase 00ではMock Tuner、原本チャンク、Fake Storage、模擬変換、契約試験を追加した。Phase 01ではローカルWorker/D1/DOの認証とGoの署名付きWSS、再接続、永続履歴を実装した。本体の残作業と検証範囲は[実装状況](docs/phase-01-progress.md)にある。

Goのjoin/rotateをローカルWorkerへ接続し、新資格でのWSS接続、応答喪失時の旧資格の隔離、管理者による再参加を追加した。

Lifecycleで接続中の期限前更新とWSS再接続を追加した。旧接続を回収してから更新し、障害の再試行枠とbackoffを引き継ぐ。本番の鍵保管・再起動復旧・長時間運転は未検証である。

履歴v2へ非秘密の資格確認情報を追加した。再読込後は最後の資格だけを照合し、更新途中・別鍵・旧Clientを拒否する。v1の命令履歴は保持する。本番の秘密値保管Providerは未実装である。

別のGoプロセスへの資格復元と、Workerの更新成立後のSIGKILLを試験する。旧資格・別鍵・pending履歴からの復元を拒否する。試験資格は親のメモリと専用IPCだけで受け渡し、本番KeyProviderは未実装のままとする。

public clientのS256・state・nonceとメモリ内資格を追加し、Mock IdPの認可コード交換を既存のAPIセッションへ結んだ。権限・失効・別origin・中断・ログアウト未確認・通信上限を検証する。ログイン画面と実IdPは未実装・未検証である。

popupでの認可結果復帰と、loopback TLS上の実Chromium試験を追加した。originとWindowProxy、callbackのURL消去、ACK、終了と中断を扱う。合成認証画面を追加し、実IdP・本体UI・PWAは未検証のままとする。

制御APIの本文を全体5秒・8192バイト・16384回に制限し、中断と異常streamを拒否する。DOへ再シリアライズする本文では元の長さ・圧縮・転送方式を引き継がない。本番のDoS耐性は未検証である。

共通Go制御コードをEncodeNode役で検証し、試験構成とIPCの期待Roleを照合する。15秒のHeartbeat、更新後の再接続、別プロセス復元、録画命令の拒否を追加試験する。EncodeNodeの製品Agentや変換処理は追加していない。

Capture Permit v2の比較資料、未実装の実行モデル、DESIGN試験を追加する。回答で採用した署名形式と世代分離はADR-026へ反映し、現行v1と録画実行は変更しない。

JWT用途、Schema ID、v1のwire形式と永続履歴は名称変更でも維持する。旧npm名・Go import・内部環境変数は未公開の開発用であり、新しい名称を使う。既存のnpm run mockは継続する。安定版Releaseはまだ作成していない。
