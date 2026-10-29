# Capture Permit v2の候補仕様

状態は提案・未採用。[ADR-026](../../architecture/decisions/ADR-026-capture-permit-v2-proposal.md)の比較材料である。署名形式と認可世代は回答待ちで、現行API・Go Agent・録画処理へ適用していない。サンプルは合成した未署名claimsと論理Storage Scopeで、録画許可として使用できない。

## v1との差と責務

| v1 | v2で提案する扱い |
| --- | --- |
| claimsとdetached signature、正規化は未定 | Compact JWSを推奨。JCSを使うdetached方式も比較する |
| permitId | jtiを不変のPermit IDとする。配送messageIdから分ける |
| nodeIdだけの主体拘束 | issuer/audience/sub、家庭・環境・Node・tuner役を必須で照合する |
| captureScopeは任意 | 必須。multiplexへの拡大は明示したNode policyも要求する |
| 認可と割当の世代が未定 | authorizationEpochとassignmentEpochを、短命資格と接続の世代から分ける候補 |
| 日時文字列 | iat/nbf/expとofflineAllowedUntilを安全な整数秒に限定する候補 |
| storageGrantRef | storageScopeIdで論理権限を指定し、短命Upload Grantは別に発行・検証する候補 |

Permitはcaptureの範囲を許可する。利用者API、Nodeの接続、原本のcanonical公開、削除、再生の権限には転用しない。予約intentと割当はDurable Storeを正本とし、DOの一時接続状態やNodeの自己申告から期待値を作らない。

## 署名形式の候補

推奨するJWSのalgはEd25519、typはtelestra-capture-permit-v2+jwt、audienceはtelestra-tuner-captureとする。専用の設定済み公開鍵集合からkidを選び、未知鍵、alg/typの違い、未対応header、jku/x5u/jwk、b64/critの変更を拒否する。受信Tokenから鍵やURLを選ばない。

署名対象は受信したJWS signing inputのバイト列とする。署名検証後もJSONの重複キー、不正UTF-8、深さ、未知claims、整数・サイズ・時刻・bindingを検証する。未来の確定予約を検証して保持する処理と、nbfまで実行を待つ処理は分ける。候補の内側JWSは最大8KiBを案とし、外側の16KiB制限も実バイト数で確認する。今回のモデルは解析済みobjectを扱うため、raw JWSの厳格なJSON parserを実装したものではない。探索試験のJSON.parseを製品の検証器へ転用しない。

既存のNode・利用者・制御Tokenは今回変更しない。新algのjose探索試験はメモリ内で行い、鍵や署名済みTokenをファイル、ログ、証跡へ出さない。Goの新alg対応、固定JWKSでの相互運用、鍵の更新・失効は未検証である。

## 認可と割当の世代

authorizationEpochは失効・再認可の世代、assignmentEpochはrecordingの割当と許可内容の世代とする候補である。通常のcredentialVersion更新やWSSのsessionEpoch更新とは意味が異なる。署名が正しくても、信頼済みの現在値と一致しなければ拒否する。Nodeが受け取ったPermit自身から現在値を補ってはいけない。

長い録画では、オフライン許可の更新を通常のCredential更新とは別に調停する。新しい不変jtiとassignmentEpochを使い、nbfとexpを信頼済み予約の許可期間内に限定する。実行中の期間更新は同じattemptを維持し、再割当や物理的な再試行は新attemptへ分ける。署名を検証した更新と、期待する世代・キャッシュの置換を確定してから使い、古いPermitへの巻き戻りを拒否する。この永続的な置換と実行の調停はまだ実装していない。

Nodeに失効が到達したら保存した失効・世代を使って拒否する。分断中に未到達の失効を即時に反映したとは表示しない。再接続後はDurable Storeの値へ照合し、古い割当からcanonicalを公開できないよう条件付き更新する。これらの永続化と公開処理は今回のモデルにはない。

期待するpolicyはD1の現在値または署名検証済みの保存済みsnapshotから取得する。WSSの切断コードやCredential期限切れだけで、録画権限の失効や認可世代を推測しない。policyの署名、版、失効状態、単調な世代を運ぶメッセージと、その確定保存・再起動時の照合を採用前に定義する。モデルのanchorKnownは、その機構を実装したものではない。

## 時刻・オフライン・容量

提案モデルはiat≤nbf<exp、nbf≤offlineAllowedUntil≤exp、最大有効時間と最大オフライン時間を照合する。開始前は待機し、expとofflineAllowedUntilの境界では期限切れとする。信頼する世代や時計の確認情報が不明な場合、時計が保存済み時刻より戻った場合は実行へ進めない。

制御または保存先が使えない場合は、明示したオフライン期限とNodeに予約済みのスプール枠を必要とする。スプール0・満杯ではオフライン実行不可とする。オンラインでスプール0の場合も有限のアップロード用メモリが必要になる。実際のTS packet、書込率、ディスク、背圧、満杯時の停止は別の実装・測定を要する。

モデルの例は30分を使うが、本番のTTLや回線断耐性の既定値ではない。遠い将来の予約をオフラインで実行するには、その開始を含む許可期間と容量を事前に確定する必要がある。権限の期間と、保持できる媒体量を分けて測定する。

分断中の旧Nodeと再割当先が、それぞれの確認済みpolicyで同じrecordingを録画し得る。この場合は別attemptへ保存する。物理exactly-onceや、旧Nodeの即時停止を保証しない。モデルは両方の候補がオフライン実行条件を満たす例を含む。

## Storage ScopeとUpload Grant

[scope.schema.json](scope.schema.json)は論理権限の候補であり、署名URLやUpload Grantではない。家庭・環境・Node・recording・attempt・Adapter・namespace・prefix・PUT・原本書込用途・chunk上限を照合する。任意URL、読取、削除、canonical書込へ権限を広げない。

論理prefixは現行のrecordings/録画/attempts/attempt/を維持する。家庭は署名対象のbindingとnamespaceへ拘束する。R2などの物理bucket・tenant prefixへの対応、実Cloudflare権限、専用Grantの有効期限・実量・hash・再利用は採用後に別途実装する。モデルだけでSEC-06に合格したとは扱わない。

## 実装への導入を止める条件

v1のSchemaやcapture.startを暗黙に変更しない。新種別または新protocol version、対応能力の交渉、拒否と移行を先に定義する。未対応Nodeへの送信と、検証失敗後のv1 fallbackは行わない。reservation.snapshotの分割・revision・確定手順、Go生成器のuri format対応、鍵と世代の保存・復元も採用前に検証する。

## 今回の検証

Node.js 24.22.1と既存の依存物で実行する。新しい依存物や実環境の権限は不要である。

```sh
node --experimental-strip-types --test tests/permit-proposal.test.ts
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run check
```

| ID | 実施内容 | 結果と限界 |
| --- | --- | --- |
| DESIGN-01 | Schemaの必須項目・境界、v2候補に対する現行APIの拒否 | macOS arm64で成功。構造検証と非採用の確認で、録画許可ではない |
| DESIGN-02 | 家庭・環境・Node・予約・世代、Scopeとnamespace・prefix・方法、multiplex | macOS arm64で成功。信頼済みpolicyを与えるモデルで、D1やStorageを実装していない |
| DESIGN-03 | 期限、スプール0・満杯、時計、分断中の2Nodeと別attempt | macOS arm64で成功。物理録画、容量や停止の実測ではない |
| DESIGN-04 | joseのEd25519 alg往復、未来予約の待機、用途違い・改ざん・URL鍵header・過大JWSの拒否 | macOS arm64で成功。合成鍵を使う探索試験で、製品検証器やGoとの同値試験ではない |
| npm run check | 終了コード0 | 既存16件とDESIGNの4件、Phase 01の51件、Go race対象コマンド、型・契約・書式・日本語コメント・公開前検査が成功。既存Goソースの試験キャッシュ再利用を含む |
| 秘密・公開情報 | 検出0件 | Gitleaksの作業ツリーと全ref履歴、公開前検査の260ファイルと履歴。検出値をログへ出さない |
| ブラウザ | 今回はローカルで再実行していない | Web・API・認証ライブラリの製品コードは変更せず、CIのbrowser jobで回帰を確認する |

日本語コメントと説明はYomiyasuで確認する。DESIGNの結果をSEC/REL/MEDの合格として数えない。実チューナー、実録画、実クラウド、製品のPermit検証器、予約実行、canonical選定、鍵・policy・時計の永続化は未実装または未検証である。
