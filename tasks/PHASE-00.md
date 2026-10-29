# Phase 00 — Contract / Repo / Mock

**スコープ**: 実チューナー、GPU、Cloudflare、AWS等へ接続しない最小の縦方向検証。

## 実装

1. Mono repo（`apps/web`, `apps/api`, `nodes/tuner`, `nodes/encoder`, `packages/contracts`, `packages/storage`, `tests/fixtures`）を整え、npm/pnpm、Go、lint/test commandsをREADMEへ記載。現存するファイルを無断削除しない。
2. `contracts/`のJSON Schemaを型生成等の入力として導入し、Envelopeの`type`ごとに実行時payloadバリデーションを用意。unsupported messageは拒否。
3. MockMirakurun/mirakc実装（Programs/Services/Channels/Streamのテスト用）を作る。実放送コンテンツは同梱しない。
4. Recording/attempt/manifestのDBインメモリ実装とfake object storage（immutable write+hash/length検証）を作る。
5. Fake TS chunkを生成し、正しい順序で再構築→SHA-256が一致するテストを作る。
6. MockEncodeNodeとPlayback manifestの作成/取得だけを最小に実装（本物のCodec対応を装わない）。
7. CIのlint/test/contract/check scriptを整備し、`docs/08-acceptance.md`のテストIDでレポート。

## 完了条件

- `CORE-01/02`, `MED-01`をpass。異常系（破損hash、重複sequence、欠損chunk、未知command、期限切れ）を含む。
- 例示プロファイルからアプリ/Nodeのmockを起動する文書がある。
- 外部クラウド本番権限を要求しない。
- 機能未実装部分は`not implemented`とし、成功を装わない。

## Phase 01への入力

Node ID/Credential/Roleの扱い、署名方式のADR、DB永続化方針、型生成方針。
