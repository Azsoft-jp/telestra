# Phase 00の実装・検証報告

この報告はPhase 00完了時点の記録である。以後の日本語コメント修正とローカル認証試験は[現在の実装状況](phase-01-progress.md)に記録する。

## 目的と範囲

`tasks/PHASE-00.md`だけを実装した。指定されたルート文書と設計資料を読み、契約とMockによる再現性を優先した。アプリ全体の完成、本番準備完了、実録画の動作保証は対象外である。

開始時の作業ディレクトリは空で、Gitも未初期化だった。添付ZIPを既存ファイルの上書きなしでルートへ展開した。元の検査は`python3 scripts/validate_package.py`だけで、初回実行は成功した。Python、Node.js、npm、Goを利用できた。今回許可された本番・課金操作はなく、既存の外部資格情報の有無は調査していない。秘密値の取得、デプロイ、クラウド資源作成、実チューナー・実録画への接続は行っていない。依存物はローカルキャッシュから導入した。

## 変更点

npm workspacesとGoモジュールを作り、指定の7ディレクトリを配置した。元の4つの契約Schemaは保持し、Mockと型別payloadの契約を追加した。型生成の入力をJSON Schemaへ統一し、生成差分、format、条件節、未知フィールドを検査する。

GoのMockMirakurun/MockMirakcはPrograms、Services、Channels、Streamのテスト面を提供する。188/204バイト単位の合成データを分割し、元と同じ順序へ復元する。実Backendの互換性は未検証であり、FFmpeg、独自EIT解析、DB、Web UIをTunerNodeに追加していない。

Fake Storageはimmutable書込、長さ・SHA-256検証、同一書込の冪等性、主体・テナント・prefix・方法・サイズ・期限の照合を行う。台帳はRecordingとAttemptを分け、検証後だけ完了Snapshotを登録する。原本と架空の字幕・音声付随情報は録画試行の保存領域へ残し、模擬変換結果を別領域へ保存する。

MockEncodeNodeと再生要求は、検証済みの出力マニフェストを作成・取得する。`playable:false`と`codecSupport:"not implemented"`を常に返す。変換待ちと保存済みを分け、原本の自動削除を実装していない。実UIは未実装で、日本語の空・待機・失敗・切断・復帰中・権限なしの文言を用意した。

変更したファイルは[ZIP基準の変更一覧](phase-00-files.md)に列挙した。文書間の差異と質問候補は[ADR-011](architecture/decisions/ADR-011-phase00-mock-boundary.md)と[ADR-012](architecture/decisions/ADR-012-contract-discrepancies.md)へ記録した。重大な設計決定を上書きしていない。

## テスト結果

ローカル環境はmacOS arm64、Node.js 24.22.1、npm 11.19.1、Go 1.26.8、Python 3.14.8である。Git commitはnullとして記録し、TS試験にはソースのSHA-256も残す。再現コマンドは[実行手順](phase-00-runbook.md)にまとめた。

| 試験・検査 | 結果と確認範囲 |
| --- | --- |
| `CORE-01` | pass。両Mock Backend、原本保存、模擬変換、再生要求、起動例、途中転送・変換失敗、再試行、認可条件、出力破損を検証 |
| `CORE-02` | pass。全12種の型別payload、未知command、未知フィールド、不足項目、不正format、過大入力、期限切れ、未来時刻、数値化できない日時、別Node・旧世代を拒否 |
| `MED-01` | pass、合成素材限定。188/204バイトの原本分割・再構築、SHA-256一致、破損hash、重複sequence、欠損、誤順序、別attempt、容量上限を検証 |
| `PH00-01` | pass。受け入れ判定器の自己試験。必須ID不足、skip、fail、不正・重複した証跡、試験プロセスの異常を拒否 |
| `npm test` | pass、13件成功・失敗0件・skip0件 |
| `npm run contract:check` | pass。全9Schemaのコンパイル、例示JSON、生成型の差分検知 |
| `npm run lint` | pass。TypeScript strict、書式、Go vet、error戻り値の破棄検査 |
| `npm run test:go` | pass。Mockと静的検査器の試験をrace付きで実行 |
| `npm run check` | pass。配布物、契約、静的検査、TS試験、Go試験の一括実行が終了コード0 |
| `npm ci --offline --ignore-scripts --no-audit --no-fund` | pass。固定したlockfileをローカルキャッシュから再導入 |
| GitHub Actions | 設定を追加。リモートでは未実行 |
| 日本語レビュー | yomiyasuの指示と静的検査を適用。利用者・支援技術による実機テストは未実施 |

機械可読の記録は`artifacts/phase00-results.json`と`artifacts/go-results.json`、詳細はそれぞれの`evidenceUri`にある。TS試験はID、環境、fixture、期待・実際の結果、pass/fail、時刻を記録する。Goの出力も別に保存する。初期の未実装状態では契約テストとGoテストが失敗したことを確認してから実装した。

## 継続確認で修正した不具合

RFC3339のうるう秒表記はSchema検証を通るが、JavaScriptの`Date.parse`では`NaN`になる。以前のEnvelope検証では、発行時刻または期限が`2016-12-31T23:59:60Z`の場合に期限判定をすり抜けた。回帰試験が失敗することを確認し、数値化できない時刻を拒否するよう修正した。同じ瞬間を表すUTCとJSTのoffset表記は引き続き受け付ける。これはEnvelopeのMock検証に限定した対処であり、TSのPTS/PCRや実メディアの時刻処理は未検証である。

受け入れ判定は、試験プロセスが正常終了し、有効な証跡がすべてpassで、`CORE-01/02`と`MED-01`それぞれのpassが存在する場合だけ成功する。以前の判定は必須IDの不足を確認していなかった。今回、`acceptance`に合否・必須ID・不足ID・問題種別を記録し、試験プロセスの終了コードと受け入れ判定の終了コードを分けた。これは記録の充足を調べる検査であり、署名や不正なCI実行の防止を提供しない。

証跡は排他的に作成し、同じ試験IDと名前の上書きを拒否する。単独試験の証跡も実行単位の保存先へ分け、実在するJSONを参照する。一括実行では、その実行のログを`evidenceUri`へ記録する。当初の11件に日時と受け入れ判定器の2試験を追加し、現在は13件となった。

## 確認済み事項

188バイトの合成原本は2,444バイト、4チャンクから復元し、SHA-256は`d0d163f0a4c5fb6eae933fbd2951e92f82cb1dcd53f9e6e7d1ad50c941ad9468`と一致した。204バイト形式も固定fixtureのhashと一致した。未検証・不足・破損した原本や変換物を成功として登録・返却しない。

別attemptの原本は別キーとなり、古いrevisionでcanonicalを変更できない。これは単一プロセスのMock試験であり、`REL-02/03`の実環境合格ではない。認可条件の否定試験も`SEC-*`の認証・失効を含む合格には読み替えない。

ローカル例からMockを起動できる。本番を表すdual-static例はSchema検証だけを行い、起動時は明示的に拒否する。公開API、任意Shell、任意URL fetch、任意パス書込の操作は提供していない。

## 未確認事項と既知の限界

実チューナー、Mirakurun/mirakcの版別互換性、Linuxでの実機動作、実TSのPES/GOP跨ぎ、ARIB/DRCS/字幕消去/文字スーパー、実音声、PTS/PCR、Codec、ブラウザ再生、GPUは未検証である。`MED-02`以降を合格にしていない。

WSS、OIDC、署名・正規化、Replay防止、失効、Origin/CSRF、持続的なrate limit、D1/R2/Queues/DO、レプリカ、バックアップ、PWA、UIアクセシビリティ、二重静的配信、障害ドメイン、RPO/RTO/SLOは未実装・未検証である。`NODE-*`、`SEC-*`、`REL-*`、`UX-*`に合格を付けていない。GitHub Actions上のOS・ツール導入を含む実行も未検証である。

## 脅威・障害リスク

`MockActor`と`MockGrant`は呼出元が作れる開発用の信頼済み文脈であり、認証や署名を提供しない。これを公開APIへ接続すると、なりすましを防げない。Phase 01で認証済みの主体と環境へ拘束する必要がある。

台帳、原本、付随情報はメモリ内にあり、プロセス終了で失われる。1MiBの原本、64チャンク、8MiBのStorageなどの上限はMock用である。満杯時はエラーで停止し、既存データを上書きしない。実スプール、回線断耐性、永続化、孤立オブジェクトの回収、自動再試行は未実装である。試験では明示的な有限回数の再試行だけを行う。

メモリ内の条件付き更新と強整合なMapは、R2やD1の条件付き更新・整合性を証明しない。SHA-256は保存バイトの検査であり、署名、権利確認、再生品質の証明ではない。字幕・音声fixtureは架空の付随情報で、実メディアの完全保存・完全再現を証明しない。

## Phase 01に必要な入力

Node ID、Credential、Roleの発行・紐付け・保管・ローテーション・失効を決める。初期の単一家庭のUser/Node/Recording認可範囲、APIの環境分離、許可Origin、時刻ずれの許容値を指定する。

署名方式のADRで、現行SchemaのEd25519を採用するか、JSONの正規化、署名対象、tenant/environment/generation/captureScopeの拘束、オフライン予約の失効規則を確定する。鍵の取得・配布は別の承認と手順に従う。

D1第一実装を維持し、予約intent、attempt、冪等キー、公開hashの永続化、条件付き更新、監査、移行・復元方針を具体化する。Envelopeの名称差とEPG試験IDの衝突、実Backendごとのpayload、型生成器の継続・移行も[ADR-012](architecture/decisions/ADR-012-contract-discrepancies.md)の質問候補を使ってレビューする。

これらの入力と実装・検証の順序は[Phase 01への引き継ぎ](phase-01-handoff.md)に整理した。この報告の完了時点では提案だけであり、その後の着手範囲は[現在の実装状況](phase-01-progress.md)に記録する。
