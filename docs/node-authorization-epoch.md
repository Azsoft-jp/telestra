# Node認可世代の永続化

[ADR-027](architecture/decisions/ADR-027-node-authorization-epoch.md)に基づき、D1の認可世代を短命Credentialから分離した。[ADR-026](architecture/decisions/ADR-026-capture-permit-v2-proposal.md)の選択をサーバー側の実状態へ反映する変更で、署名付きpolicyと実録画の完成ではない。

## 実装

[追加移行](../apps/control/migrations/0002-authorization-epoch.sql)でnodesへauthorization_epochを加えた。初期値は1、初回joinで2となる。再参加と失効で進め、通常rotateやWSSの接続世代更新では変更しない。状態・資格・認可の更新は同じrowで確定する。

世代上限でjoin/rotateを拒否しても、失効はstatus=revokedへ確定する。上限に達した世代は上限に保ち、0へ戻さない。失効の再送、同じ登録の再送、別家庭・環境への要求で認可を復活させない。未移行DBと不正な値を認可世代1で補完せず、503で拒否する。

既存のJWT・HTTP応答・WSS形式・Nodeのjournalは変更していない。DBの値をNodeの信頼済みpolicyに読み替えるAPIも追加していない。[v2検証器](capture-permit-v2-verification.md)のexecutionAuthorizedは引き続きfalseである。

## 検証する範囲

[合成fixtureの6試験](../tests/phase01/authorization-epoch.test.ts)は実workerdとローカル永続D1を使用する。

| ID | 確認する動作 |
| --- | --- |
| PERMIT-04 | 通常更新、再参加、参加権利再利用の拒否、失効の再送、Worker再起動後の復元 |
| PERMIT-05 | v1の既存DBを移行、未移行時の拒否、旧JWT・予約・録画の保持、DB型・範囲制約 |
| PERMIT-06 | 認可・資格世代の上限、参加権利を消費しない拒否、上限での失効確定、再登録で復活しないこと |
| PERMIT-07 | SQLite Triggerで認可世代の書込を拒否し、join batchの全体rollbackと失効失敗を確認。通常rotateは認可列へ書き込まない |
| PERMIT-09 | 同じ参加権利の同時使用で一度だけ更新、未知の世代指定を拒否、鍵・Role変更による初期化の拒否 |
| PERMIT-08 | rotateと失効の同時要求、無権限と未知項目の拒否、別家庭・環境の同一Node IDの隔離、再起動後の失効保持 |

Token、秘密鍵、参加コードはメモリ内だけで扱い、assertionや実行ログへ値を表示しない。Triggerは固定した試験SQLで、利用者がSQLを実行できるAPIではない。本番Cloudflare、実IdP、実チューナー、実番組は使用しない。

## 実施結果

macOS arm64、Node.js 24.22.1、Go 1.26.10で検証した。最初に追加したPERMIT-04は認可列がないため失敗し、移行と処理の実装後に成功した。

| コマンド | 結果 |
| --- | --- |
| 対象6試験の実行 | 6件成功 |
| npm run check | 成功。単体・Mock 22件、認証・制御58件、Go race、型・Schema・書式・コメント・公開前検査を含む |
| npm audit --audit-level=moderate / govulncheck ./... | いずれも検出0件 |
| gitleaks dir / git --all | 作業ツリーと既存Git全refsで検出0件。完全伏字を指定 |
| yomiyasu lint・差分確認 | 実施。コード構文のコロンとファイル一覧の箇条書きは維持 |

ローカルのChromium・IaCは今回再実行していない。PRのCIではcheck・browser・security・iacを別途確認する。本番・実機試験は実施していない。

## 未実装・限界・次の作業

署名付きpolicyの配信・保存・Node側の復元、割当世代と予約revisionの調停、Storage Scope/Upload Grant、原本録画は未実装である。DB列の追加と6試験を、SEC-06やREL、Phase 02全体の合格とは扱わない。

DBや端末のバックアップ全体を古い状態へ戻す操作には別の信頼根が必要となる。分断中に未到達の失効を即時反映したとは表示しない。オフライン許可上限、対象OSと鍵保管、時計・キャッシュの復旧条件は引き続き入力が必要である。

状態確定後の監査・接続終了の後段障害、実ディスク停止、広域D1障害の試験は未実施である。

本番への0002移行は未実施。追加列を削除するrollbackや、認可世代を更新しない旧Workerとの混在運用も未検証である。次はD1の現在値へ拘束した署名付きpolicyと、Nodeの確定保存を実装する。

## 変更ファイル

この差分の13ファイル。

- [CHANGELOG.md](../CHANGELOG.md)
- [apps/control/auth.ts](../apps/control/auth.ts)
- [apps/control/index.ts](../apps/control/index.ts)
- [apps/control/migrations/0002-authorization-epoch.sql](../apps/control/migrations/0002-authorization-epoch.sql)
- [docs/08-acceptance.md](../docs/08-acceptance.md)
- [docs/architecture/decisions/ADR-027-node-authorization-epoch.md](../docs/architecture/decisions/ADR-027-node-authorization-epoch.md)
- [docs/architecture/decisions/README.md](../docs/architecture/decisions/README.md)
- [docs/implementation-files.md](../docs/implementation-files.md)
- [docs/node-authorization-epoch.md](../docs/node-authorization-epoch.md)
- [docs/phase-01-progress.md](../docs/phase-01-progress.md)
- [docs/phase-01-runbook.md](../docs/phase-01-runbook.md)
- [tests/phase01/authorization-epoch.test.ts](../tests/phase01/authorization-epoch.test.ts)
- [tests/phase01/helper.ts](../tests/phase01/helper.ts)
