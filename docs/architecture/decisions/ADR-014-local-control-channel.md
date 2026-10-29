# ADR-014 ローカルの署名付き制御接続

状態はPhase 01のローカル検証向け採用。本番の鍵運用、実IdP、実環境WSS、Capture Permitの暗号検証・実行は対象外とする。

## 契約と方向

Phase 00のEnvelopeとMock payloadは変更しない。`contracts/control.schema.json`へ署名付き接続の定義を追加する。`messageId/expiresAt`を用い、文書上の`commandId/deadline`を別名として暗黙に追加しない。管理APIの`commandId`は、配送するEnvelopeの`messageId`と同じ値にする。NodeのACKは`correlationId`で対応づける。

JWSはADR-013のEd25519を使う。Token用途を`tv-control+jwt`とし、Node資格やBrowser資格から分ける。方向ごとにissuerとaudienceを照合し、家庭、環境、Node、資格世代、接続世代、本文、有効期限を検証する。JWTの`jti/iat/exp`とEnvelopeの`messageId/issuedAt/expiresAt`は一致させる。JSONを再シリアライズして署名を照合しない。受信したURLから鍵を取得しない。

Nodeから受け付けるのは`node.hello`、`node.heartbeat`、`command.ack`だけとする。サーバーからは`session.ready`、`control.receipt`、`capture.start`、`capture.cancel`を送る。`hello`で登録した役割と能力を照合する。Encoderへ録画制御を送らず、Nodeから制御命令を注入させない。

`capture.start`は外側の署名とpayload構造、対象Node、明示されたcaptureScopeを検証する。既存Capture Permitの形式は維持する。内側のPermitの暗号検証・オフライン実行規則は後続実装まで保留する。試験Nodeは`not implemented`を返し、媒体処理を開始しない。ACKはNodeからの応答であり、原本保存・録画完了の証明にはしない。

## 接続と永続状態

外部経路は`https://…/agent`のUpgrade、Node側の設定は`wss://…/agent`に限定する。Node経路はOrigin付き要求、Browser Token、Cookieだけの認証、クエリによる資格指定を拒否する。ローカル試験ではMiniflare内でUpgradeを行い、実際のTLS通信を検証したとは扱わない。

握手にはNode資格に加え、X-TV-Device-Proofヘッダーで端末鍵の署名を要求する。connect用途と資格のjtiへ拘束し、証明のjtiをDO storageで一度だけ消費する。Bearerだけの要求や再利用した証明では既存接続を閉じない。途中で失敗した場合は新しい証明を作り直す。

NodeごとのDO名に家庭と環境を含める。再接続時はD1の`session_epoch`を条件付き更新で進め、古い接続を閉じる。フレームごとにD1の失効と資格・接続世代を再確認する。APIによる資格更新・失効ではDOへ照合を通知する。予約intentと録画台帳はD1に置き、接続切断で削除しない。

未ACK命令はDO storageへ保存してから送信する。同じ資格世代の再接続後、`hello`を確認してから同じ命令IDと新しい接続世代で再送する。Nodeが報告する再開位置だけで未ACK命令を捨てない。新しい資格世代へ古い命令を再配送しない。旧世代の待ち命令も期限までは枠を使用する。Node側の永続的な重複実行防止が必要であり、物理exactly-onceは保証しない。

## ローカル試験の上限

署名付きフレームは16KiB、寿命は最大30秒、受信は接続ごとに60件/分、接続試行はNodeごとに12回/分とする。Binaryは拒否する。未ACKは8件、命令履歴は32件・合計64KiB、履歴は命令期限後5分まで保持する。上限では429または接続切断を返す。期限切れを再試行で延長しない。管理APIの期限はJWTの秒精度へ切り下げ、現在の資格期限も越えさせない。

Heartbeat間隔は15秒、無通信切断は45秒、`hello`待ちは10秒とし、DO alarmで資格期限も照合する。再接続はGoの有限回Runnerで管理し、既定は8試行、待機は指数backoffとjitterで最大30秒にする。資格・プロトコルの失敗は再試行せず、中断要求で待機を終える。これは接続制御の実装であり、GoのWSS Transportとの統合は未完了である。

## 残る質問と限界

上限値はローカル検証用であり、本番の性能やDoS耐性を保証しない。送信済みの操作を失効通知で回収することはできない。Nodeの重複実行記録、確定予約キャッシュ、Capture Permitの署名・失効・時刻ずれ、通信分断中の実行規則を次の実装で確定する。実環境WSS、DOのhibernation単体、地理的障害、長時間負荷は未検証として残す。
