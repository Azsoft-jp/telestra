# 02 / メディア、字幕、EncodeNode、Storage

## 原本の定義と保存モデル

- 原本は、受信Backendから提供されたTSの**実際のバイト列**。サービス選択後かmultiplexかを`captureScope`とbackend/filter設定として記録。
- 原本chunkは188 byteのMPEG-TSパケット同期を前提に切る。ただし188/204のパケット形式と先頭同期は入力検出で検証。任意のPES/GOP/字幕管理データを跨ぎ得る。
- 各chunkは`recordingId/attemptId/seq`のimmutable object。長さ、SHA-256、時刻範囲、連続性/欠損を記録。
- `PUT`成功、サイズとhash検証、manifestのdurable commit、canonical公開という順序。未完了Multipart Uploadを再生対象としない。
- 完了した原本chunkを連結すれば、保存済み入力のバイト列を再現できることをテスト。
- 複数attemptがある場合にバイト連結で自動的に混ぜない。統合作業は独立した修復ジョブとする。

## 再生形式

| モード | 条件 | 方針 |
| --- | --- | --- |
| Browser default | 地デジMPEG-2等 | H.264/AAC、HLS/fMP4等へEncode/Remux後に再生 |
| Verified Direct | 端末が入力codec/容器に対応 | 能力テスト成功時のみ |
| Original download | ユーザーが明示的に原本を選択 | TS書出、プレイヤー互換は表示 |
| Encode unavailable | 変換処理可能Nodeなし | 原本録画は続行、プレイヤーに`変換待ち` |

`mpegts.js`はMPEG-TSコンテナを扱うがMPEG-2 Videoをブラウザ用にソフトウェアデコードするものではない。Cloudflare WorkersでフルFFmpegエンコードを行う設計も採らない。

**Playback segmentとraw chunkの混同禁止**。EncodeNode/Packagerがキーフレーム、PAT/PMT（TS-HLS時）、init fragment、音声境界、DTS/PTSと`EXT-X-DISCONTINUITY`/epochを処理し、検証済みセグメントを公開する。

## ARIB字幕・文字スーパー

正本はplain WebVTTではなく、元の情報を十分に保持する可逆的表現とする。候補は生ARIB group/ID3/特殊WebVTT cue。実装方法はgolden fixtureで選定しADR追加。

最低限のフィールド:

- 種別：`caption` / `superimpose`、language、表示可否
- 元PTS/PCR、正規化presentation time、`timelineEpoch`、音声・映像へのoffset
- DRCS/外字、ルビ、色、位置、装飾、字幕管理情報と消去命令
- seek時に字幕デコーダー状態を復元するcheckpoint/pre-roll
- PID/言語/コンポーネント切り替え、タイムスタンプwrap/reset/discontinuity

保存形式とexport:

| 出力 | 情報保持 | 用途 |
| --- | --- | --- |
| `arib-preserved` | 完全再現を目標（fixture検証が必要） | PWA自前字幕描画 |
| `webvtt-arib-embedded` | 特殊cueにARIBを格納する候補、専用プレイヤー前提 | 専用描画器 |
| `webvtt-plain` | フォント/制御情報が失われ得る | 汎用互換字幕 |
| `burned-in` | 映像に固定、ON/OFF不可 | 要求された書出のみ |

`b24tovtt`にはARIB情報を特殊WebVTT cueへ保持する方式がある。「WebVTTだからすべて不可逆」としない。KonomiTVの字幕実装/ライセンスに依存する場合は依存ライブラリごとに通知・ライセンス検証が必要。

## EncodeNode

入力: `raw-manifest`/ライブ入力ソース（認可済み）、profile、jobId、source hash、区間、字幕/音声方針。出力: rendition manifest + segmentation/track/timeline metadata + encoder version +検証結果。

能力登録はcodec/resolution/backend/MaxSessions/availableMemory/live/post/processVersion。単純な`gpu=true`だけで割り当てない。

- `priority=live`に専用枠を確保し、後処理でライブを飢餓状態にしない。
- Post encodeはcheckpoint/chunk境界でリトライ。ただしエンコードの独立性がない場合はpre-rollを確保し、重複区間をtrim。
- 失敗時は別EncodeNodeへ割当。異種GPU/CPU切替時は新`streamEpoch`、`discontinuity`、codec/init更新。無停止継続は保証しない。
- 原本は変換完了だけで削除しない。利用者が設定したRetentionPolicy、checksum、字幕/音声検証、Replica状態を満たした後に限定。
- サーバーレスControl Planeは重いエンコードを実行しない。

## StorageAdapter

Adapterは名前だけの`put/get`でなく、少なくとも`rangeRead`,`conditionalWrite`,`multipartUpload`,`presignRead`,`presignWrite`,`atomicRename`,`append`,`consistency`をcapabilitiesとして示す。機能未対応なら対応経路を明示的に選択する。

- `putImmutable(objectKey, bytes, sha256, expectedLength)`を中心にする。
- 録画データの読取/書込許可はactor、scope、prefix、サイズ、期間に限定。
- Manifestはバージョン付き、公開ポインターは条件付き更新/世代管理。
- `R2`, S3/B2, `Local`は最小実装。B2等の料金・外向き転送制約は最新の公表内容で再確認。
- 事後エンコード入力をストレージから再読する際、全ファイルをメモリに載せない。

## 必須Media fixture

- MPEG-2 / AAC / MPEG-TS、途中でPES/GOP跨ぎ
- ARIB字幕の色/ルビ/位置/DRCS/消去/文字スーパー
- Dual-mono、副音声、5.1↔stereo、PID変化、解像度変化
- interlace、1440×1080 SAR/DAR、PTS wrap、PCR reset
- 途中でFrame loss、duplicate chunk、ネットワーク停止

Fixtureは再配布可能な合成素材か権利者の許諾済み素材だけを使用。
