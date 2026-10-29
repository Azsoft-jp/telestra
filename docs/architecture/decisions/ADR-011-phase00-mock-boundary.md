# ADR-011 Phase 00の実装境界

状態はPhase 00内の採用。既存のADR-001〜010を変更しない。

## 決定

Cloudflareを第一実装とする設計を保持する。Phase 00では本番Adapterを作らず、外部通信を行わないインプロセスのAPI、台帳、StorageとGoのMock Tunerを実装する。HTTP/WSリスナー、WSS認証、DB永続化、実コーデック、PWA、IaCは`not implemented`とする。

元の4つのJSON Schemaは保持する。型別payload、Mock Tuner出力、Mock再生要求・結果、架空のトラック情報のスキーマを追加する。実行時にはAjv 2020とformat検証を使う。公式の[JSON Schema対応資料](https://ajv.js.org/json-schema.html)を確認した。

型はJSON Schemaからローカルの小さな変換スクリプトで生成し、CIで生成差分を検知する。変換対象はこのリポジトリで使う構造と参照に限定する。範囲、format、条件節は実行時に検証する。新しい構造を使う場合は変換器も更新する。署名用のJSON正規化には使用しない。

Mockの12種のpayloadはPhase 00の検証用である。Mirakurun/mirakcの実API互換や、コマンド実行を保証しない。Mockの両Backendは同じ合成カタログを提供する。実APIの互換性に差があれば、後続Phaseで別契約とAdapterを作る。

原本チャンクと架空の字幕・音声付随情報を`recordings/.../attempts/.../`に保存する。模擬変換結果は`renditions/.../`へ分離する。付随情報はAttemptレコードが参照し、変換後も保存する。ARIB保存形式をこのMockで決定しない。再生結果には常に`playable:false`と`codecSupport:"not implemented"`を返す。

## 代償と検証

台帳とオブジェクトは再起動で失われる。条件付き公開は単一プロセス内の比較だけであり、D1やLeaseの保証ではない。原本は最大1MiB、64チャンク、Fake Storageは8MiBに制限する。読取は全体をメモリに置くため、実メディアへ流用しない。

`CORE-01/02`と`MED-01`を合成fixtureで検証する。`MED-02`以降、`NODE-*`、`SEC-*`、`REL-*`、`UX-*`の本来の合格を意味しない。

Envelopeでは、Schemaのdate-time形式が有効でも、実行環境で数値化できない発行・期限日時を拒否する。うるう秒を推測で補正しない。受け入れコマンドでは必須3 IDのpassを要求し、不足・skip・fail・不正・重複した証跡と試験プロセス異常を合格にしない。

## Phase 01でレビューする提案

型変換器を継続するか、Draft 2020-12への対応を確認した型生成器へ移行するかを決める。D1の条件付き更新、署名の正規化、公開manifest hashへ付随情報を含める方法は別ADRとする。
