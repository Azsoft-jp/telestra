# Phase 03 — EPG / Search / Reservations

## 実装

1. Backend Programs等の差分取り込み。sourceVersion/lastFetchedAt/provenanceを保存。
2. Service identity、ProgramOccurrence ID、再利用Event ID、延長/変更履歴。
3. 手動録画、番組予約、キーワード予約、シリーズ予約、前後margin。
4. Scheduler: tuner能力/重複/競合/優先度/再割当、ユーザー向け理由。
5. 確定予約snapshotをAgentへ届け、切断中の限定実行と再同期。
6. PC/MobileのEPG read API、検索のpagination/rate limit、最終更新・空データの状態。

## 完了条件

- `EPG-01/02/03/04/05/06/07`, `REL-07`に対するfixture/test。
- 番組名・Event ID単独を一意キーにしない。
- EPGソース停止中も古い情報であることを明示。
- 予約を受理したことと録画の実行/成功を混同しない。
