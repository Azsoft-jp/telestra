# 01 / アーキテクチャ・責務・状態

## 責務の境界

| コンポーネント | 所有する処理 | 所有しない処理 |
| --- | --- | --- |
| `TunerNode` | Mirakurun/mirakcへ接続、TS中継/スプール、確定予約キャッシュ、状態・EPG差分送信 | FFmpeg、字幕描画、EPG正規化、Web UI |
| `EncodeNode` | TS入力、codec/packaging、字幕抽出・時間変換、出力確定 | チューナー制御、ユーザー認証、正規録画の選定 |
| `Control API` | 認証/認可、API Contract、予約/録画台帳、プレイバック許可 | 動画の長時間エンコード |
| `Node Registry` | Node接続、capabilities、heartbeat、失効・接続世代 | 録画原本の正本 |
| `Scheduler` | 予約・Encodeジョブ割当、Lease、retry、競合、期限管理 | TS処理 |
| `Metadata Repository` | channel/program/recording/attempt/job、監査上のイベント | 大容量TS |
| `StorageAdapter` | private object PUT/GET/range/stat/list/delete、整合性確認、capabilities | 予約判断・変換の意味 |
| `Playback Gateway` | 認可、媒体ごとのmanifest、Range処理、Cache-Control | 原本の書換 |
| `WebApp/PWA` | 予約/検索/視聴/保存UI、オフライン表示 | サーバー側認可判定の正本 |

## TunerNodeの通信

1. Agentは外向き`wss://.../agent`へ接続して、Node IDと短命Credentialを提示。サーバーは署名・資格・環境を確認。
2. `hello`へNode capabilityとチューナーBackendタイプを載せる。backpressure/heartbeat/reconnect with jitter。
3. `reservation.snapshot`へ署名された期限付き確定予約を返し、Agentは最小のローカル永続スプールを保持。
4. `capture.start`は型付きコマンドでのみ発行。対象service、時刻、captureScope、storageGrant、attempt IDを指定。
5. 原本chunkはAgentからStorage endpointへHTTPSアップロード。Agent→Worker→R2大量relayを基本パスとしない。
6. 転送ACK後、Agentは既定の安全余裕時間を経てchunk spoolを解放。APIで失敗すると再試行できる。
7. 接続回復時に、ローカルの予約結果、chunk index、attempt、session epochを再同期。未認証の反映を拒否。

## データフロー

- **EPG**: Backend Programs API → TunerNode差分 → ingest → 正規化 → catalog → WebApp / Scheduler。
- **録画**: 予約intent → Scheduler → TunerNode → `recordings/{id}/attempts/{attempt}/raw/{seq}` → hash/length確認 → attempt manifest → canonical選定。
- **事後Encode**: canonical/attempt manifest → Encoder Lease → input read → output segment → verify → encode rendition登録。
- **ライブ視聴**: 現在のTunerNode → EncodeNode/Packager → 公開済みlive segment+playlist → WebApp。配信停止時も原本録画は独立。
- **端末保存**: 認可→互換rendition選択→前景chunk DL→hash検証→OPFS等へcommit→Offline Library。

## データモデリング

主なエンティティ:

| Entity | 必須ID | 意味 |
| --- | --- | --- |
| Tenant/Household | `tenantId` | 初期は単一、将来の隔離境界 |
| User | `userId` | Identity Provider subjectへ紐付け |
| TunerBackend | `backendId` | Mirakurun/mirakcインスタンス |
| TunerNode | `nodeId` | 証明書/credentialに紐付く不変識別子 |
| Service | `serviceKey` | network/TS/service identity |
| Program | `programOccurrenceId` | 放送日時・番組identity・版を持つ |
| Reservation | `reservationId` | ユーザーが意図した予約 |
| Recording | `recordingId` | 論理的な録画 |
| Capture Attempt | `attemptId` | 1回の物理録画試行、不変prefix |
| Encode Job | `jobId` | 変換要求、不変priority/profile |
| Rendition | `renditionId` | 変換結果、元原本とprofile hashに紐付く |

## 正本と一時状態

- 予約intent、recording/attempt台帳、ジョブ、公開済みmanifest hashはDurable DBに永続化し、重複処理を防ぐ。
- Durable Objectsは接続・actor単位調整・通知を担当する。再起動したらDBとAgentのreconcileで復旧。
- Cloudflare Queuesは少なくとも1回配送とし、**2回処理しても副作用が増えない**API/workerを設計。順序はDB上のversion/epochで検証。
- D1 read replicaは読み取り負荷軽減であり、書込冗長化ではない。
- 競合予約/Node割当はrevision + atomic conditional updateで確定し、旧世代publishは409で拒否。DBの実際のトランザクション能力に合わせて実装を検証。

## Offline reservationsとsplit-brain

回線分断中に旧Nodeが確定予約を実行し、制御側で新Nodeへ再割当される可能性がある。物理的なexactly-once録画は保証できない。

**方針**: 同じ`recordingId`から複数attemptが生じても、それぞれimmutable prefixに書く。各attemptには時刻、backend、drop/captureScope、checksumを記録。接続回復後、`canonicalAttemptId`を一度に一つ選び、選定根拠と操作を監査ログへ記録。古い世代からcanonical manifestを上書きできない。

予約キャンセルがAgentに未到達ならUIは`停止確認待ち`と表示し、実録画を止めたとは宣言しない。

## 通信モデル

- Control Protocolは`contracts/node-envelope.schema.json`。`commandId`、`nodeId`、`sessionEpoch`、`issuedAt`、`deadline`、`payload`を検証。
- リトライの冪等キー: `commandId`、`reservationId`、`attemptId`、`jobId`。
- `status`と`event`を区別。クライアントは一度受けたコマンドを覚え、期限切れや旧世代を拒否する。
- `NodeOutputGrant`は正しいprefix/方法/サイズ上限/期限だけを許す。任意URL fetchおよびshell実行禁止。
- StorageAdapterが署名URL非対応なら短命中継ゲートウェイを利用できるが、限度と監査を設ける。

## v0.1のデプロイ

- Cloudflare標準で1つのAPI Worker + 役割別Durable Objects + Queues + D1 + private R2。
- TunerNodeは自宅既存Mirakurun/mirakcと同一LAN。自宅内にEncodeNodeがいれば優先。
- WebAppは静的アセット。Provider抽象化は少数の機能境界に限る。
- 全機能のmicroservice化はしない。縦方向の検証が通るまでは関連機能を一つのWorker内モジュールに整理してよい。
