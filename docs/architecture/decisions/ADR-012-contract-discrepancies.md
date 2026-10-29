# ADR-012 文書間の差異と質問候補

状態は記録と提案。重大なプロトコル変更は保留する。

| 差異 | Phase 00の扱い | 後続Phaseで確認する質問 |
| --- | --- | --- |
| `docs/01-architecture.md`は`commandId/deadline`、JSON Schemaは`messageId/expiresAt`を使う | JSON Schemaのフィールドをそのまま検証する。別名は追加しない | 冪等性とACKの対応を含め、正式名称はどちらか。`commandId`は別の業務IDか |
| `tasks/PHASE-00.md`は`MED-01`を必須とし、`docs/08-acceptance.md`はPhase 02に配置する | 優先度の高いタスクに従い、合成バイトの保存・復元だけをPhase 00で検証する | Phase 02で実TSの同期検出とストリーミングを追加検証する認識でよいか |
| `docs/03-epg.md`と`docs/08-acceptance.md`で`EPG-01〜07`の意味が異なる | 今回EPGの合格は付けない。受け入れ一覧のIDを将来の報告軸とする提案を記録する | EPG詳細試験を別のサフィックスへ移すか。既存参照をどう移行するか |
| Capture Permitに`Ed25519`があるが、署名の正規化、失効、環境・テナント・世代の拘束が未定 | Schemaの構造だけを検証する。鍵の取得・生成、署名検証、Capture Permitの実行は実装しない | Node ID/Credential/Roleの発行主体と保管先、正規化方式、ローテーション、失効中のオフライン予約をどう扱うか |
| Capture Permitの`captureScope`は任意だが、アーキテクチャのcapture開始では指定を要求する | 既存Schemaは変えず、Mock manifestには`service-filtered`を明示する | Scopeを署名対象の必須項目にするか。予約とStorage Grantの対象をどう照合するか |
| manifestはimmutableとされるが、録画中の更新versionや公開epochのフィールドが未定 | 完了時のSnapshotをメモリ台帳へ登録し、別attemptの上書きと古いrevisionを拒否する | 永続SnapshotのID、世代、canonicalの条件付き更新、付随情報とのhash拘束をどう設計するか |
| helloの例は過去の固定期限を持ち、実Backendのpayloadは未定 | 模擬時計を固定して試験する。Mock用payloadを実API仕様と呼ばない | 実機とBackendの版、時計ずれの許容値、全メッセージの正式payloadをどう固定するか |

Phase 01のDB方針はD1第一実装を維持する。Durable Objectsの一時メモリを正本にせず、予約intent、attempt、冪等キー、公開hashを永続化する。具体的なテーブル、トランザクション、移行・復元方式はまだ実装していない。

これらは質問候補であり、Phase 00のMock検証を進めるために回答を必須とはしない。実認証・実録画・本番公開へ進む前に決定と否定テストを追加する。
