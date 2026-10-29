# ADR-028 署名付きCapture Policy v2

状態はローカル実装向けの採用。[ADR-026](ADR-026-capture-permit-v2-proposal.md)の署名・世代分離と、[ADR-027](ADR-027-node-authorization-epoch.md)のD1認可世代を結ぶ。v1の制御命令を変更せず、Nodeの確定保存と実録画は引き続き有効にしない。

## 問題と決定

Permitだけを受け取り、その本文から期待する世代や保存先を作ると、署名と構造が正しくても現在の割当を確認できない。policyを別のCompact JWSとして署名し、対象Node、予約と版、recording/attempt、認可・割当世代、Backend・サービス・captureScope、論理Storage権限、時刻・容量の上限を拘束する。

policyのalgはEd25519、typはtelestra-capture-policy-v2+jwt、audienceはtelestra-tuner-capture-policyとする。専用鍵集合を使い、Permit、Node接続、利用者資格へ転用しない。受信した署名対象バイト列で検証し、未知header、鍵URL、重複JSON、非正規base64url、不正UTF-8、整数表記や深さの違反を拒否する。署名処理だけを共用し、用途の検証を入力から切り替えるAPIは作らない。

policyのjtiは不変Policy ID、permitIdは対応する不変Permit IDとする。二つの署名を別々に検証してから、発行者、Permit ID、対象・世代・範囲・期限を照合する。期間内でもexecutionAuthorizedはfalseのままで、Storage Grantや媒体処理の検証を省かない。

## D1のsnapshotと発行

[0003の追加移行](../../../apps/control/migrations/0003-capture-policies.sql)で、recordingとassignmentEpochごとのsnapshotを保存する。保存するのは署名前のclaimsと識別情報で、署名値・秘密鍵・Credential本文ではない。Node、予約、録画台帳へ外部キーを持ち、予約と録画の所有者も一致させる。

内部Scheduler向けの保存関数は、Nodeの現在の認可世代、確定予約の版、所有者、サービスと予約期間、現在の最新割当を条件にCASで挿入する。通常の予約APIが作るrevision 0を自動確定しない。更新は次の割当世代へ進め、Policy IDとPermit IDを新しくする。同じbytesの再送は書き換えない。Nodeを変える再割当では新attemptを要求し、同じattemptでBackend・サービス・保存範囲・Storage Scopeを変更しない。

この保存関数は公開HTTP APIではない。実Scheduler、予約確定のAPI、実Backendの登録、Storage Scopeの実権限確認は未実装である。fixtureでは確定予約と合成した録画台帳を明示して用意し、実録画や原本の保存とは扱わない。

発行は家庭・環境内のrecordingに対する最新の割当だけを対象とする。Nodeの役割・状態・資格と認可の世代、予約の版・状態・所有者・内容を署名前後に照合する。[D1の公式仕様](https://developers.cloudflare.com/d1/best-practices/read-replication/)を参照し、各照合で新しいfirst-primary sessionを開始する。ローカル試験は実際の地域配置やread replicaの障害を検証したものではない。

二度目の照合後にも状態は変わり得る。署名は発行済みsnapshotの正当性を示すが、配信完了時点の最新性や分断中の即時失効を保証しない。古いpolicyとPermitの組がともに正当なら、期限内の暗号検証は成功し得る。Nodeでの世代・失効の確定保存と巻き戻り拒否は別に実装する必要がある。

## 取得用HTTPSと互換性

POST /agent/capture-policy/v2は、現在のNode Credential、tuner役、登録済み端末鍵による証明を要求する。Origin付きの要求、利用者Token、別Node、未知項目、HTTPを拒否する。DeviceProofへcapture-policy用途を追加し、challengeは次の固定列とする。区切りのNULはIDの許可文字に含めない。

`capture-policy.v2\0recordingId\0credentialJti`

証明の再送は読取を繰り返すだけで、その都度D1を照合する。別録画や別Credentialへの転用は拒否する。既存のjoin/rotate/connect用途、Node JWT、CredentialResponse、WSS v1は維持する。新しいWSS命令として自動配信する変更は含めない。

専用署名鍵と最大policy有効期間は構成で必須にする。本番TTLやKeyProviderの既定値は決めない。未構成では503となり、未署名のDB値を返すfallbackを設けない。Goは既存Provisionerの確認済み資格とHTTPS構成を使い、固定path、端末証明、5秒、16KiB、同時1件、リダイレクト・Proxy・圧縮なしで取得する。読取失敗から資格や録画許可を変更せず、自動再送もしない。

## 代替案・限界・見直し条件

v1の外側制御JWSだけに依存する案は、資格・接続世代とオフラインの録画認可を混同するため採らない。Node全予約の大きなsnapshotを一度に送る案は、件数・分割・版の確定が別に必要となる。今回はrecording単位のHTTPS取得を先行し、制御WSSの16KiB上限を変えない。

新規配信後のNode確定保存、暗号化キャッシュと鍵供給、全体rollbackの検出、署名付き失効通知の配信、原本・canonical公開、snapshotの保持とGCは未実装である。再割当後の旧Nodeには過去のpolicyを返さず404とするが、このHTTP結果だけを署名付き失効通知とは扱わない。

本番の鍵・TTL・OS・時計と復旧条件、SchedulerとBackend/Storage権限、Nodeの確定保存を実装する前に見直す。実施した試験、失敗の修正、未実施の範囲は[実装記録](../../signed-capture-policy.md)に示す。
