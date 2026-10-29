# Phase 01の条件照合とEncodeNode役のGo試験

2026年10月29日に[tasks/PHASE-01.md](../tasks/PHASE-01.md)の各項目を現行コードと照合した。今回追加したのは共通Go制御コードをEncodeNode役で動かす検証であり、EncodeNodeの製品Agent、実変換、ハードウェア検出を実装したものではない。Phase 01全体は未完了である。

## 実装項目との対応

| タスクの項目 | 現在の証拠 | 未実装・未検証の範囲 |
| --- | --- | --- |
| 1. 両Nodeのjoin/issue/rotate/revoke、能力登録、Heartbeat | [資格更新試験](phase-01-provisioning.md)、[Goの相互試験](../tests/phase01/go-wss.test.ts)、今回の[EncodeNode役の試験](../tests/phase01/go-encoder.test.ts)。発行をWorkerで行い、Go側で役割を照合する | 製品としてのAgent起動・鍵供給、本番の能力検出。試験Goは能力なし・同時処理0件を広告する |
| 2. outbound WSS、世代、resumption、backoff、jitter、backpressure | [再接続Runner](../nodes/tuner/control/reconnect_test.go)、[WSS相互試験](../tests/phase01/go-wss.test.ts)、[DO試験](../tests/phase01/websocket.test.ts)。未ACK8件・履歴32件の制限と再送を検査 | 実Cloudflare、実経路、長時間・並行負荷、DOのhibernation単体。本番の履歴整理も未決定 |
| 3. OIDC利用者API、RBAC、resource-level authorization | [Mock PKCE](phase-01-browser-auth.md)、[実Chromium](phase-01-popup.md)、[利用者・録画所有者の拒否試験](../tests/phase01/identity.test.ts) | 実IdP、MFA、公開鍵更新、モバイルPWA、本体全画面の認証UX |
| 4. 型別Schema、署名、期限、限定命令 | [制御契約](../packages/control-contracts/channel.ts)、[Go検証](../nodes/tuner/wire/channel.go)、[相互署名試験](../tests/phase01/go-wire.test.ts)。Encoderへの録画命令はWorkerとGoで拒否する | 外側JWSの検証と内側Capture Permitの暗号検証は別物。v2の独立した署名検証器を追加したが、policy永続化・失効配信・オフライン実行は未実装 |
| 5. 失効、Origin、CSRF/SSRF防御、負荷・サイズ | [WS否定試験](../tests/phase01/websocket.test.ts)、[本文の制限](phase-01-body-limits.md)。Cookieだけで認証せず、Token内のURLで鍵や接続先を選ばない | 認証前の負荷、API全体の期限、本番DoS耐性、実XSS・侵入試験 |
| 6. controlと動画transferの分離 | [Go Client](../nodes/tuner/control/client.go)は型付き制御だけを扱い、Binaryを拒否する。Phase 00の媒体Mockは別経路である | 実TS転送とStorage Grantを用いるデータ面はPhase 02以降 |

## 完了条件の扱い

必要IDがレポートに存在するだけでは、各IDの全範囲に合格したとは扱わない。NODE-01/02、CORE-02、SEC-01/02/03/04のローカル境界を試験しているが、NODE-02の確定予約・attemptの実行整合性はPhase 02にもまたがる。現状の予約APIはintentを保存し、実行Nodeへの割り当てを未実装と返す。

BrowserとNodeの資格はissuer、audience、用途、鍵、Roleで区別し、混同を否定試験で拒否する。切断・workerd再起動後の予約intentと録画台帳はローカルD1で照合する。これを実クラウドのバックアップや地域障害の復旧とは扱わない。実環境WSSは未検証として残す。

## 今回の追加と実行結果

tests/phase01/go-agent.tsに試験構成のnodeRoleを渡せるようにした。既定のtunerは維持する。親がIPCで受ける資格も同じ期待Roleへ照合し、受信Tokenから検証条件を決めない。GoのClient、Provisioner、wire形式、履歴v2、サーバーの役割判定は変更しない。

| 対象 | 実行結果と範囲 |
| --- | --- |
| NODE-01のEncodeNode役 | macOS arm64で成功。Goによるjoin/rotate、TLS検証付きWSS、D1のencoder能力登録、15秒の既定Heartbeat、録画命令の403と待ち命令0件、失効後の停止 |
| NODE-02のEncodeNode役 | macOS arm64で成功。試験用に約10秒へ早めた資格更新と再接続世代1→2、resumeの旧世代1、Roleの維持、失効後の停止 |
| SEC-02のEncodeNode役 | macOS arm64で成功。親メモリ・専用IPCで資格を渡し、別Roleの履歴再利用を拒否。拒否時のD1資格・接続世代を保持し、正しいRoleでは別Goプロセスへ復元 |
| GoのRole否定試験 | race付きで成功。正しい署名のcapture.cancelを誤配送しても、EncodeNode役はACKや実行履歴を作らず1回で停止する |
| npm run check | 終了コード0。既存16件とPhase 01の51件、Go全体のrace、型・契約・書式・日本語コメント・公開前検査が成功 |
| 秘密・公開情報 | 作業ツリーと全ref履歴のGitleaksで検出0件。公開前検査も253ファイルと履歴を検査して検出0件 |
| ブラウザ | 今回はローカルで再実行していない。Web・API・認証ライブラリの製品コードは変更せず、CIのbrowser jobで回帰検査する |

最初の相互試験はTuner固定の構成でjoinedへ到達せず失敗した。固定構成からGoのIdentityと親のIPC検証へ同じRoleを渡すようにし、再実行した。初期調査ではmock-captureを受け付ける問題があると述べたが、Schemaの列挙に含まれず拒否済みであり、誤りだった。サーバーの能力検査の変更は行っていない。

再現には承認済み依存物、Node.js 24.22.1、Go 1.26.10を使う。

```sh
npm run control:build
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off node --experimental-strip-types --test tests/phase01/go-encoder.test.ts
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go test -race ./nodes/tuner/control -run '^TestClientEncoder' -count=1 -timeout=15s
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run check
```

## 残る入力と次の実装

Nodeの本番起動と復旧には、対象OS、鍵・資格の保管と供給Provider、復旧権限を確定する必要がある。これは[ADR-021](architecture/decisions/ADR-021-node-credential-checkpoint.md)の未決定事項を維持する。両Nodeの本番Agentや秘密値の保管を、試験fixtureで代用して完成済みとはしない。

Capture Permitの署名形式と認可世代は[ADR-026](architecture/decisions/ADR-026-capture-permit-v2-proposal.md)で確定した。v2の署名対象と必須scopeを独立した検証器で照合する。Storage Grantと失効中のオフライン実行は引き続き未実装で、既存v1の命令は変更しない。

今回の手書きコードの変更はGoの試験2ファイルとNodeの試験2ファイルである。条件照合、進捗、受け入れ基準、runbook、変更履歴、[全変更一覧](implementation-files.md)も更新する。本番デプロイ、実IdP、実チューナー、実録画には接続していない。

## Capture Permitの提案

[ADR-026](architecture/decisions/ADR-026-capture-permit-v2-proposal.md)と[候補仕様](proposals/capture-permit-v2/README.md)へ署名形式・世代・失効・オフライン・互換性を具体化した。ユーザーの回答によりCompact JWS v2と世代分離を採用した。[v2の独立検証器](capture-permit-v2-verification.md)をPERMIT試験で検証する。DESIGN試験の実行モデルやStorage権限は引き続き未実装で、実行許可やPhase 02の合格へ読み替えない。
