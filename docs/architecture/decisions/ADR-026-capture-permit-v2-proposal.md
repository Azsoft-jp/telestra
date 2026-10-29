# ADR-026 Capture Permit v2の署名と世代分離

状態は一部採用。ユーザーはCompact JWS v2と、認可世代・Credential世代の分離を選択した。[ADR-012](ADR-012-contract-discrepancies.md)の保留判断をこの範囲で確定する。v1の制御経路は維持する。署名検証器は追加するが、署名付きpolicyの永続化とStorage権限の検証が揃うまで録画実行を有効にしない。

## 問題

現行v1は構造だけの契約で、署名対象の正規化、家庭・環境・世代、失効時のオフライン動作が未定である。captureScopeもSchema上は任意だが、現在の制御経路は明示を要求する。構造検証や外側JWSの成功だけで、内側Permitの実行を許可できない。

短命Credentialの通常更新と録画権限の失効を同じ世代へ結び付けると、更新のたびに長い録画と予約キャッシュの再認可が必要になる。分断中の即時失効も保証できない。認可世代の扱いは録画実行前に確定する必要がある。

## 採用する判断

v2を別契約にし、Compact JWSの署名対象バイト列を検証する。[RFC 7515](https://www.rfc-editor.org/rfc/rfc7515.html)に従い、受信JSONの再シリアライズで署名を照合しない。[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)を参照し、専用typ・audience・鍵集合・固定アルゴリズムで資格の転用を拒否する。

[RFC 9864](https://www.rfc-editor.org/rfc/rfc9864.html)の完全指定された識別子Ed25519をv2に採用する。曲線もEd25519へ固定する。既存のEdDSA制御Tokenは今回変更しない。Go・Node.js・実workerdでの署名と拒否の相互試験はPERMIT-01/02/03で確認する。

認可世代authorizationEpochと割当世代assignmentEpochを、CredentialのcredentialVersionと接続sessionEpochから分ける。通常の資格更新は認可世代を進めず、失効・鍵の再登録・権限変更では進める。割当と許可内容の更新ではassignmentEpochを進め、実行中の許可更新ならattemptを維持する。再割当や物理的な再試行は新attemptとする。canonical公開は制御側の現行世代と条件付き更新で別に判定する。

期待する認可状態は署名付きpolicyとDurable Storeへ拘束する。接続資格の期限切れやWSS close codeを、録画権限の失効通知と読み替えない。policyの配信と確定保存を、実行より先に実装する必要がある。

家庭、環境、Node、役割、予約IDと版、recording/attempt、Backend、サービス、captureScope、時刻、オフライン期限、スプール上限を署名対象の必須項目にする。Storageの論理権限storageScopeIdを参照し、短命Upload Grantの期限と録画許可の期限を混同しない。

詳細は[候補仕様と検証](../../proposals/capture-permit-v2/README.md)、[claims Schema](../../proposals/capture-permit-v2/claims.schema.json)、[Storage Scope](../../proposals/capture-permit-v2/scope.schema.json)へ分ける。claimsの正本はcontractsへ移し、提案資料から参照する。Storage Scopeと実行条件のモデルは未実装のまま残す。[検証器の範囲と限界](../../capture-permit-v2-verification.md)に実装結果を記録する。

## 代替案とトレードオフ

v2でもdetached Ed25519署名を使い、[RFC 8785のJCS](https://www.rfc-editor.org/rfc/rfc8785.html)で正規化する案がある。外形をJSONとして読める一方、GoとJavaScriptの数値・文字列・並び順を含む正規化の同値試験と実装が必要になる。必須bindingを増やす以上、v1のまま互換と宣言することはできない。

認可をcredentialVersionへ結び付ける案は新しい世代を減らせるが、通常rotateのたびにPermit再発行とキャッシュ置換を調停する必要がある。分断中の予約継続を維持するなら、旧資格に結び付いたPermitをいつ止めるかも明示する必要がある。

オンライン実行だけを先行する案は試作の段階としては可能だが、確定予約のオフライン実行を含むPhase 02の完了とは扱わない。ローカル容量0で分断耐性を保証する案は採らない。

## 互換性と導入条件

現行capture.startとreservation.snapshotのv1を黙って変えない。新しいメッセージ種別またはprotocol versionと、明示した能力交渉を別途定義する。未対応Nodeへv2を送らず、検証失敗からv1へfallbackしない。16KiBの制御上限を暗黙に引き上げず、予約snapshotの分割・revision・確定順序を検証する。

v2 claimsを独立したcontractsのSchemaとして生成器へ追加する。提案のuri formatは、固定HTTPS発行者との完全一致と両言語で同じ構成制約に置き換える。汎用URI形式の同値性を保証したとは扱わない。APIや実録画への適用を先に進めない。

## ユーザーが確定した設計選択

| 項目 | 採用 | 比較した別案 |
| --- | --- | --- |
| Q1 署名形式 | 新規v2のCompact JWS | 新規v2のdetached署名とJCS |
| Q2 失効世代 | 認可世代とCredential世代を分ける | Credential更新ごとにPermitを再発行する |

オフライン権限の最大時間、対象OS・鍵保管、時計・キャッシュの復旧、StorageAdapterの実権限も実行を有効にする前の入力として残る。例示の30分を本番既定値や耐障害保証にはしない。

## 見直し条件

署名形式と世代分離は回答により採用済みとする。鍵失効と世代の永続化、分断・二重attempt、Storage Grantの実検証が揃った時点で録画実行の導入可否を再評価する。DESIGN試験の成功だけでSEC-06、REL-01/02/03やPhase 02を合格にしない。
