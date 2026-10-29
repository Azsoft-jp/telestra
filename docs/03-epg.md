# 03 / EPG、予約、チューナー競合

## ソースと責務

- Mirakurun/mirakcの`channels`, `services`, `programs`等の既存APIから取得する。Backendごとに互換契約テストを書く。
- TunerNodeは差分取得・転送、ローカル確定予約キャッシュを担当。EIT独自解析と番組名の正規化を持ち込まない。
- Control PlaneのEPG Ingestionがデータの検証、時刻正規化、ソース識別、重複排除、更新/失効処理、履歴・provenanceを担当。
- 定期ポーリングとイベント通知を併用可能にする。ただし同じ情報が二重到着しても更新は冪等。
- 番組表には最終更新時刻と取得失敗を表示。古いEPGを新しいと偽らない。

## Identity

`serviceKey`はoriginalNetworkId/transportStreamId/serviceIdなどから構成（Backendごとに欠損・異常値を検証）。番組は`eventId`単独で同定しない。service、event、放送日/時期、sourceVersion、放送開始/終了、更新履歴を保存。

- 同じEvent IDの再利用を許す。
- 放送延長/差替えに対して、同一番組の更新か新しい番組かを判断し、予約と履歴に記録する。
- タイトルで予約identityを作らない。キーワード予約は別のRuleとMatching logとして保存。
- EPGのタイムゾーン表示は`Asia/Tokyo`。内部時刻はUTC instant + source local notationで保持。DST等の考慮は一般化。

## Reservation state

`draft → scheduled → assigned → armed → preparing → recording → finalizing → completed`。
例外: `conflict`, `missed`, `failed`, `cancel_pending`, `cancelled`。

- 予約はユーザーintentを永続化し、Schedulerがチューナー資源・先行予約・サービスの競合を計算。
- Node接続がなくてもユーザーに予約が成功したと偽らない。`scheduled`は予約intent受理、`assigned`は実行ノード決定、`armed`はAgentから確定応答を意味するなど明確にする。
- 各TunerNodeは確定した有限の予約スナップショットを永続保持。クラウド接続断時に既定の範囲内で予約実行できる。
- 分断中に変更した予約は未配達としてUIに`配信待ち`。キャンセルは`停止確認待ち`、Agent確認が届くまで`cancelled`としない。
- 機器が複数サービスを同時処理できるかはBackend capabilityで判断。単純に1チューナー=1番組と固定しない。
- 開始前余裕/終了後余裕、延長、放送休止、イベントID変更、手動予約を扱う。

## EPG画面の動作

- PC: チャンネル×時間のグリッド、現在時刻線、番組詳細、1操作で予約/解除（確認が必要な操作は明示）。
- Mobile: 初期は現在放送/次番組/検索/日付切替を優先。横スクロールの多列表は任意モード。
- スケルトン/空/更新遅れ/オフライン/予約競合を区別。
- 検索は局名、番組名、説明、ジャンル、時間範囲、録画済みを扱い、キーワード予約の条件を説明できるようにする。
- 「予約済み」と「録画成功」は別表示。

## テスト

- `EPG-01`: 同一programの差分・重複・順序逆転でも一意に収束。
- `EPG-02`: Event ID再利用・番組差替え・延長で誤予約/二重予約を起こさない。
- `EPG-03`: チューナー能力、資源競合、前後marginに対する解の説明が可能。
- `EPG-04`: 予約コマンド送信後オフライン、旧Agentと新Agentの競合を`attempt`で吸収。
- `EPG-05`: 予約取り消しが未到達なら`cancel_pending`で表示。
- `EPG-06`: EPGソース停止中も既存データは更新時刻付きで検索可能。
- `EPG-07`: JST/UTC、境界日付を跨ぐ番組の表示と予約が一致。
