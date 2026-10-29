# Phase 04 — EncodeNode / Captions / Playback

## 実装

1. EncodeNode capabilitiesとlive/post job、priority/lease/checkpoint。
2. 原本manifestを読み、H.264/AAC出力に必要なdemux/decode/encode/remux/packageを正しく分離。
3. ARIB情報を保持する字幕/文字スーパーsidecar、render/seek/pre-roll、音声トラック対応。
4. 条件に応じNVENC/QSV/VAAPI/CPUの対応をfeature detect。使えないbackendは無理に選ばない。
5. Job failure/fallbackで新generation/streamEpoch/manifest discontinuityを処理。
6. Playback Gatewayは認可済みmanifest/segment/range取得を提供。
7. 端末codec capabilityに応じDirect/Transcodeを決定。地デジMPEG-2の無条件Directは禁止。

## 完了条件

- `MED-03/04/05/06/07/08/09/11`, `REL-05`, `SEC-05`のgolden fixture。
- 字幕を焼き込まずON/OFF切替できる出力を最低1方式。
- 失敗したencode jobが原本録画を削除/壊さない。
- ライブ低遅延/画質切替の実測前に「完全シームレス」と記載しない。
