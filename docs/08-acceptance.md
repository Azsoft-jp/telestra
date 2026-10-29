# 08 / 受け入れ基準と検証マトリクス

最終的な受け入れはテスト結果と環境を記録して判断する。下表は**未実行の設計上の合格条件**。

Phase 00のローカルMock実行結果は[検証報告](phase-00-report.md)を参照する。`CORE-01/02`と合成入力の`MED-01`を対象とし、下表の後続Phaseの試験結果には読み替えない。

Phase 01のローカルHTTP・DO WebSocket試験は[実装状況](phase-01-progress.md)に記録する。`NODE-01`、`SEC-01/02/03/04`のローカル境界と、`NODE-02`のサーバー側再開・無通信切断を検証した。Goの署名と永続履歴は[ADR-015](architecture/decisions/ADR-015-go-wire-and-command-journal.md)の範囲で検証した。GoのループバックTLSによるWSS接続・再接続は[ADR-016](architecture/decisions/ADR-016-go-wss-transport.md)、参加・資格更新は[追加のTLS相互試験](phase-01-provisioning.md)、接続中の更新は[Lifecycleの加速試験](phase-01-lifecycle.md)で検証した。既定間隔の長時間運転、確定予約の実行、実IdP、実環境WSSは未検証で、Phase 01全体は未完了である。

資格確認情報の再読込は[履歴v2の試験](phase-01-checkpoint.md)で追加検証した。同一プロセス内のWorker再接続と、子プロセス途中終了による記録保持を区別する。本番KeyProviderを伴う完全な再起動復旧は未検証である。

利用者の認可コード交換からAPIセッションまでを[Mock PKCE試験](phase-01-browser-auth.md)で追加した。SEC-04・SEC-01・CORE-02のprotocol境界を対象とし、ログイン画面、実ブラウザの遷移・CORS、実IdPの合格とは扱わない。

[popupとChromiumの記録](phase-01-popup.md)で、SEC-04・CORE-02とauth fixtureのUX-08を追加した。UIの一部、loopback TLS、合成IdPの範囲であり、Phase 05全体や実IdPの合格ではない。

[本文読み取りの記録](phase-01-body-limits.md)で、CORE-02・SEC-10の5秒・8KiB・中断を追加検証する。認証前の負荷、API全体や本番のDoS耐性へ読み替えない。

[Phase 01の条件照合](phase-01-role-audit.md)では、両RoleのGo制御試験と製品Agentの実装を区別する。必要IDがあっても、確定予約の実行や本番の鍵供給まで合格とはしない。

| ID | 合格条件 | 推奨Phase |
| --- | --- | --- |
| CORE-01 | Mock Tuner/Storeで権利問題なくend-to-end実行 | 00 |
| CORE-02 | JSONスキーマで未知command、過大payload、不足フィールドを拒否 | 00/01 |
| NODE-01 | 失効Node、不正署名/期限切れ/重複を拒否 | 01 |
| NODE-02 | 切断→jitter再接続→確定予約/attemptの整合性維持 | 01/02 |
| MED-01 | TS原本をチャンク化/再構築して入力とSHA-256一致 | 02 |
| MED-02 | PES/GOP/字幕管理データがchunkを跨いでも再構築可能 | 02/04 |
| MED-03 | MPEG-2 browser DirectPlayを誤判定しない | 04 |
| MED-04 | DRCS/ルビ/色/位置/消去/文字スーパー/複数言語のgolden fixture一致 | 04 |
| MED-05 | seek・字幕checkpoint/pre-roll再生・復元に成功 | 04/05 |
| MED-06 | PTS wrap/reset、PCR不連続・epoch変更で同期維持 | 04 |
| MED-07 | dual-mono、副音声、5.1、PID変更を扱う | 04 |
| MED-08 | interlace、1440×1080 SAR/DARを正常出力 | 04 |
| MED-09 | fallback新epoch/init/discontinuityを生成し途切れ時間を測定 | 04 |
| MED-10 | 完全オフラインで動画・字幕・音声トラックを再生 | 05 |
| MED-11 | 不足chunk/変換物を成功と誤表示しない | 02/04 |
| EPG-01 | Event ID再利用/延長/差替え、重複差分で誤予約しない | 03 |
| EPG-02 | チューナー競合の理由/優先度を説明可能 | 03 |
| EPG-03 | JST境界・source age・オフライン表示が正しい | 03/05 |
| SEC-01 | 認可されないrecordingId読取を拒否 | 01/04 |
| SEC-02 | 偽造Nodeを拒否/失効反映 | 01 |
| SEC-03 | WS command注入/旧世代/oversizeを拒否 | 01 |
| SEC-04 | 悪性Origin/CSWSH/CSRF、セッション期限切れを拒否 | 01/05 |
| SEC-05 | Encoder URI/引数にSSRF/command injection不可 | 04 |
| SEC-06 | アクセスgrantはprefix/時間/サイズ/方法に限定 | 02 |
| SEC-07 | State/CI/log/artifactにSecretが残らない | 06/07 |
| SEC-08 | Retention誤操作を防ぐ/復旧できる | 07 |
| SEC-09 | PWA/SW/XSS/CSPの否定テスト | 05 |
| SEC-10 | API/WS/Storage quota・rate limitでDoSを緩和 | 07 |
| REL-01 | 30分のクラウド断でローカル容量/録画結果を測定 | 02/07 |
| REL-02 | 同一予約が2Nodeで録画されてもattempt上書なし | 02/07 |
| REL-03 | stale leaseからcanonical公開できない | 02/07 |
| REL-04 | upload断後再試行してhash/manifestを一意に確定 | 02 |
| REL-05 | EncodeNode kill → retry/新Node →結果検証 | 04 |
| REL-06 | Primary storage停止で安全な状態遷移を表示 | 02/07 |
| REL-07 | DB write unavailableで予約を成功扱いしない | 03/07 |
| REL-08 | 同一build hashの2静的サイトが表示可能 | 06 |
| REL-09 | 予備フロントでAPI停止を`UIのみ利用可能`と表示 | 06 |
| REL-10 | metadataとrecordingの復元演習が再現可能 | 07 |
| UX-01 | 初回登録のhappy path 4ステップ以内 | 05 |
| UX-02 | 予約競合/通信断/変換待ちに適切な対処を提示 | 05 |
| UX-03 | 視聴中の回線断→再接続/停止状態を説明 | 05 |
| UX-04 | PWA前景保存を途中停止→再開しhash一致 | 05 |
| UX-05 | ネットなし再起動で保存済み字幕・音声再生 | 05 |
| UX-06 | 320px/768px/1200px/TVで操作不能・はみ出しなし | 05 |
| UX-07 | キーボード、SR、フォーカス、コントラストを検査 | 05 |
| UX-08 | 日本語の状態/操作文言に誤解がない | 05 |
| UX-09 | 別originにPrimaryのOPFS/Sessionを自動引継しない | 06 |
| UX-10 | 端末保存の容量不足・期限切れ・部分失敗が分かる | 05 |

## Gate

- **Phase 00**: 契約+Mock+検証ツール/CI、少なくともCORE-01/02がgreen。
- **Phase 02**: MED-01/02、REL-02/03/04、SEC-06がgreen。実回線の性能は別途。
- **Phase 04**: Media golden fixturesと端末compatibility matrixを確認。未カバー機種を列挙。
- **Phase 05**: UX全項目の対応・未達を表示。WCAG 2.2 AAは自動テストに加え手動レビュー。
- **Phase 07**: SEC/RELテスト・DR訓練・ログ・運用手順。未合格なら本番安全性を宣言しない。

各テストレポートは`testId, commit, environment, fixtureId, expected, actual, status(pass/fail/skip), evidenceUri, timestamp`を記録。`skip`は`pass`と数えない。
