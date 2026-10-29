# Capture Permit v2の署名検証

ユーザーはCompact JWS v2と、認可世代・Credential世代の分離を選択した。決定は[ADR-026](architecture/decisions/ADR-026-capture-permit-v2-proposal.md)へ反映した。v1のcapture.start、Node Credential、制御JWSは維持し、v2検証失敗から旧形式へ戻す処理は設けない。

## 実装範囲

[claims Schema](../contracts/capture-permit-v2.schema.json)からTypeScriptの型、Worker用の事前生成検証器、Goへ埋め込む契約を生成する。[TypeScript](../packages/capture-permit/index.ts)と[Go](../nodes/tuner/wire/permit_v2.go)は専用の固定公開鍵集合、Ed25519、typ、audience、issuer、家庭・環境・Node・予約・割当・保存先の論理権限を照合する。公開鍵は1〜8本、JWSは8KiB、headerは1KiB、JSONの深さは32までとする。識別子と固定用途名はASCIIに限定し、制御文字を拒否する。

署名対象は受信したCompact JWSのバイト列を使う。未知header、埋込鍵、鍵URL、重複キー、非正規base64url、不正UTF-8、未知claims、安全な整数の範囲外を拒否する。v2の数値は10進整数表記だけを受け付け、丸めによる解釈差を防ぐため、小数点と指数を含む表記も拒否する。この制限は旧v1へ追加しない。

発行者は最大512文字の固定HTTPS文字列と完全一致させる。構成で使えるのはASCIIのホスト、任意の数値port、英数字・ハイフン・ドット・アンダースコア・チルダ・スラッシュのpathである。認証情報、query、fragment、動的な鍵取得、汎用URI検証には対応しない。従来の提案にあったuri formatを、両言語で照合する同じ構成制約へ置き換えた。

期待値は呼出元が確認したpolicyから渡す。Permit自身から補ってはならない。認可世代、割当世代、予約の版と対象を完全一致させる。既知の失効、確認情報の欠落、保存済みの観測時刻より戻った時計を拒否する。通常のcredentialVersionと接続sessionEpochは、この検証contextに含めない。

iat≤nbf<exp、予約の許可期間、有効時間上限、オフライン期限上限、スプール上限を検査する。開始前はwaiting、nbfからexpの直前まではactiveを返し、expでは拒否する。activeは有効期間内という意味だけで、offlineAllowedUntil後のオフライン実行を許可しない。いずれの場合もexecutionAuthorizedはfalseである。

## 検証

- PERMIT-01はTypeScriptの署名・用途・対象・世代・時刻を検証する。
- PERMIT-02は110件の同じ合成入力をNode.js・Go・実workerdへ渡し、正常、待機、拒否の判定を照合する。Goの署名もNode.jsとWorkerで検証する。Workerの外向きfetchは拒否し、呼出回数も検査する。
- PERMIT-03はTypeScriptの鍵数、未知項目、別方式、固定発行者、鍵集合の差替え、非同期検証中の期待値変更を検証する。
- Goのrace試験は同じ検証器を16並列で使い、旧Node資格への転用、鍵差替えと認可世代変更による拒否を確認する。

試験の鍵と署名済みJWSはメモリと親子プロセスのIPCだけで扱う。実番組、実チューナー、本番Cloudflare、本番資格は使用しない。署名・鍵・本文をassertionの値や証跡へ書かない。

## 実施結果

ローカルではGo 1.26.10、Node.js 24.22.1、macOS arm64を使用した。以下は合成fixtureによる結果で、実機や本番環境の合格ではない。

| コマンド | 結果 |
| --- | --- |
| npm run check | 成功。単体・Mock 22件、認証・制御52件、Go race、型・Schema・書式・コメント・リンク・公開情報検査を含む |
| PERMIT-02の共有行列 | Node.js・Go・実workerdの110件が一致。署名済み入力もログへ出さない |
| govulncheck ./... | Go 1.26.10で検出0件 |
| npm audit --audit-level=moderate | 検出0件 |
| gitleaks dir / git --all | 作業ツリーと既存Git全refsで検出0件。出力は完全伏字を指定 |
| yomiyasuのlint・ADR差分確認 | 実施。正本という用語、ファイル一覧の箇条書き、コード構文のコロンは文脈を確認して維持 |

初回の一括検査では既存の再ログイン試験が1件失敗した。Browserだけ固定時計を使い、実時計のMock IdPと秒境界でずれる条件を再現した。同じ実時計に期限確認用の差分を加える試験へ修正し、製品の時刻検証は維持した。修正後に一括検査を再実行し、52件すべて成功した。ローカルChromiumとIaCは今回再実行していない。PRのCIではcheck・browser・security・iacの結果を別途確認する。

## 未実装と残るリスク

署名付きpolicyの配信・永続化・再起動照合、キャッシュの単調な置換、Storage ScopeとUpload Grantの暗号検証、録画開始、物理スプール、時計の信頼源は未実装である。検証器の成功をSEC-06、REL-01/02/03、Phase 02全体の合格とは扱わない。

分断中に未到達の失効を即時反映する保証はない。旧Nodeと再割当先の重複録画も起こり得る。実行前には別attemptへの原本保存と、制御側の現行世代によるcanonical公開の条件付き更新が必要となる。

次は署名付きpolicyと世代の確定保存、Storage権限の検証、新しい制御メッセージと能力交渉を契約試験から追加する。オフライン権限の本番上限、鍵保管方式、対象OS、時計とキャッシュの復旧条件は引き続き入力が必要である。

## 変更ファイル

この差分の36ファイル。生成物はSchemaまたは生成器から更新し、手書きコードには日本語コメントを付けた。

- [CHANGELOG.md](../CHANGELOG.md)
- [contracts/capture-permit-v2.schema.json](../contracts/capture-permit-v2.schema.json)
- [contracts/control.schema.json](../contracts/control.schema.json)
- [docs/08-acceptance.md](../docs/08-acceptance.md)
- [docs/architecture/decisions/ADR-012-contract-discrepancies.md](../docs/architecture/decisions/ADR-012-contract-discrepancies.md)
- [docs/architecture/decisions/ADR-026-capture-permit-v2-proposal.md](../docs/architecture/decisions/ADR-026-capture-permit-v2-proposal.md)
- [docs/architecture/decisions/README.md](../docs/architecture/decisions/README.md)
- [docs/capture-permit-v2-verification.md](../docs/capture-permit-v2-verification.md)
- [docs/implementation-files.md](../docs/implementation-files.md)
- [docs/phase-01-progress.md](../docs/phase-01-progress.md)
- [docs/phase-01-role-audit.md](../docs/phase-01-role-audit.md)
- [docs/proposals/capture-permit-v2/README.md](../docs/proposals/capture-permit-v2/README.md)
- [docs/proposals/capture-permit-v2/claims.schema.json](../docs/proposals/capture-permit-v2/claims.schema.json)
- [docs/proposals/capture-permit-v2/example.json](../docs/proposals/capture-permit-v2/example.json)
- [nodes/tuner/cmd/permitfixture/main.go](../nodes/tuner/cmd/permitfixture/main.go)
- [nodes/tuner/wire/contracts_generated.go](../nodes/tuner/wire/contracts_generated.go)
- [nodes/tuner/wire/permit_v2.go](../nodes/tuner/wire/permit_v2.go)
- [nodes/tuner/wire/permit_v2_test.go](../nodes/tuner/wire/permit_v2_test.go)
- [packages/capture-permit/index.ts](../packages/capture-permit/index.ts)
- [packages/capture-permit/json.ts](../packages/capture-permit/json.ts)
- [packages/contracts/generated.ts](../packages/contracts/generated.ts)
- [packages/contracts/index.ts](../packages/contracts/index.ts)
- [packages/control-contracts/runtime.d.mts](../packages/control-contracts/runtime.d.mts)
- [packages/control-contracts/runtime.mjs](../packages/control-contracts/runtime.mjs)
- [scripts/generate-go-control.mjs](../scripts/generate-go-control.mjs)
- [scripts/generate-types.mjs](../scripts/generate-types.mjs)
- [scripts/test.mjs](../scripts/test.mjs)
- [tests/capture-permit.test.ts](../tests/capture-permit.test.ts)
- [tests/fixtures/permit-cases.ts](../tests/fixtures/permit-cases.ts)
- [tests/fixtures/permit-worker.ts](../tests/fixtures/permit-worker.ts)
- [tests/fixtures/permit.ts](../tests/fixtures/permit.ts)
- [tests/permit-proposal.test.ts](../tests/permit-proposal.test.ts)
- [tests/phase01/browser-auth.test.ts](../tests/phase01/browser-auth.test.ts)
- [tests/phase01/capture-permit.test.ts](../tests/phase01/capture-permit.test.ts)
- [tests/phase01/go-wire.test.ts](../tests/phase01/go-wire.test.ts)
- [tests/proposals/permit-model.ts](../tests/proposals/permit-model.ts)
