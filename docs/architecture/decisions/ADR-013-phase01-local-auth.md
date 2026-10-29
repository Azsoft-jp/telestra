# ADR-013 Phase 01のローカル認証・永続化

状態はローカル実装向けの採用。本番の認証・鍵運用は未決定のまま残す。ユーザーの継続実装指示に基づき、Phase 01の契約と実装を進める。

## 決定

Cloudflare Workers、D1、Durable Objectsを第一実装とし、Miniflare/workerdでローカルに検証する。試験の外向きfetchを拒否する。実チューナー、本番クラウド、課金資源、実IdPは使わない。初期の家庭IDは環境設定で一つに限定する。

BrowserのAccess Token、NodeのCredential、Nodeの署名付き制御を別の用途として検証する。Browserは設定したIdPのissuer/audienceと公開鍵を使用し、家庭とRoleはサーバーのD1台帳から取得する。リクエストのRoleや所有者を認可根拠にしない。Nodeはtuner/encoderの機能種別を持ち、利用者のoperator/adminとは分ける。

ローカルの署名はEd25519のJWSを使用する。署名対象は実際のJWS signing inputのバイト列であり、受信JSONを再シリアライズして照合しない。公開鍵は設定または台帳の登録値からだけ選び、受信したjku/x5u等のURLを取得しない。既存EnvelopeのmessageId/expiresAtは維持し、署名するclaimsへtenant/environment/node/credential generationを拘束する。Capture Permitの既存ドラフトは暗黙に変更しない。

試験専用の鍵はテスト中にメモリ内だけで生成し、秘密値をソース、ログ、証跡、構成ファイルへ保存しない。本番の鍵作成・取得・配布・ローテーションはこの決定に含めない。

D1は主体、所属、Node identity、joinの一回限りの権利、資格世代、失効、予約intentと録画台帳の永続保存を担当する。DOは接続とメッセージ制御を担当する。Nodeの接続世代を更新し、失効または古い世代の通信を拒否する。Node接続がなくなっても永続台帳を削除しない。

## 検証と限界

改ざん、別用途のToken、別Node、別家庭・環境、期限切れ、失効、再利用、悪性Origin、過大入力を拒否する。D1はローカル永続領域を使い、workerdを停止・再起動して状態を照合する。

ローカルで成功しても、実環境WSS、IdP、D1/DOの地理的な障害、バックアップ、鍵の運用を検証済みとしない。実Codec、実放送、字幕完全再現、PWAの実装は別Phaseのままである。
