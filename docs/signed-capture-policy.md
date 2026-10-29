# 署名付きCapture Policyの発行と取得

[ADR-028](architecture/decisions/ADR-028-signed-capture-policy.md)に基づき、D1の確定した割当からpolicyを発行し、Goが端末証明付きHTTPSで取得・検証する経路を追加した。Permitとpolicyの両方が正しくても、実行許可はfalseのままである。Nodeの確定保存と実録画の完成ではない。

## 実装した経路

確定予約・録画の所有者・Nodeの認可世代 → 内部Scheduler向けCAS保存 → 最新割当の照合 → 専用鍵で署名 → 現在値を再照合 → HTTPS → Goの署名・主体・期限検証、という順に処理する。

[policy Schema](../contracts/capture-policy-v2.schema.json)を型、Worker用の事前生成検証器、Goの埋込契約へ生成する。policyとPermitは、それぞれ固定したalgと専用typ・audience・鍵集合で検証する。両者の発行者、Permit ID、対象・世代・範囲・期限を照合してから期待値を構成する。一般のJSON再シリアライズを署名照合には使わない。

D1では[0003](../apps/control/migrations/0003-capture-policies.sql)を0001・0002の後に適用する。[保存・発行](../apps/control/capture-policy.ts)は現在のNode・予約・録画所有者と最新割当へ拘束する。同じrecordingでも別Nodeへ割り当て直した後は、旧Nodeへ古いsnapshotを返さない。通常のCredential更新は録画認可の世代を進めない。

保存関数は内部向けで、一般利用者がclaimsを投入できるAPIではない。実Schedulerと予約確定APIは未実装である。通常の予約APIが作るrevision 0は未確定として拒否する。fixtureではrevision 1と合成した既存録画台帳を明示する。

## 境界と構成

| 境界 | 制限 |
| --- | --- |
| policy/PermitのCompact JWS | 各8KiB、header 1KiB、JSON深さ32、未知項目・重複キー・不正UTF-8・非正規base64urlを拒否 |
| D1に保存するpolicy claims | 4KiB。世代は安全な整数、予約期間は開始を切上げ・終了を切下げた整数秒の内側 |
| 取得要求 | HTTPS専用、8KiB、現在のNode資格とcapture-policy用途の端末証明、Nodeごと毎分12件 |
| Goの取得 | 固定path、5秒、応答16KiB、同時1件、自動再送なし、リダイレクト・Proxy・圧縮なし |
| 署名鍵 | TELESTRA_CAPTURE_POLICY_PRIVATE_JWKをメモリから供給。値をソース・ログ・成果物へ保存しない |
| 最大有効期間 | TELESTRA_CAPTURE_POLICY_MAX_LIFETIME_SECONDSとNodeの検証構成で明示。試験の3600秒は本番既定値ではない |

未構成、未移行、署名失敗、現在値の不整合を、未署名policyや既定の認可世代で補完しない。取得エラーと署名付きの割当失効は区別する。HTTPの401/404、Credential期限、WSS切断を単独で録画権限の失効へ読み替えない。

policyも署名済みsnapshotであり、常に最新であることを証明しない。過去に発行したpolicyとPermitがともに期限内なら、暗号検証だけでは成功し得る。新しい世代や失効をNodeで確定保存し、古い組へ戻さない処理は次の実装となる。

## 検証

| ID | 対象 |
| --- | --- |
| POLICY-01 | 独立したpolicyとPermitの署名・ID・世代・期限・失効、別発行者の混入拒否 |
| POLICY-02 | 実workerd/D1の発行、同一保存の再送、再起動、通常rotateでの維持、再参加と失効 |
| POLICY-03 | 未確定予約、別Node/Role、別用途や別録画の端末証明、同時CAS、再割当後の旧Nodeを拒否 |
| POLICY-04 | Goから実ループバックTLSを通じた取得、端末証明、専用公開鍵、失効後の拒否 |
| POLICY-05 | 同じ94件をNode.js・Go・実workerdで照合。歴史的に正当な組と最新性の違いも確認 |
| POLICY-06 | 実D1の書込失敗、読取と署名の間の失効・予約・割当・録画所有者の変更で成果物を返さない |
| POLICY-07 | 署名未構成、予約と録画の別所有者、明示した署名付き割当失効 |

Goのrace試験では同じ検証器の並行利用、5秒の本文待機上限、同時取得の拒否、中断後の復帰、読取失敗で資格を変えないこと、別URLへの転送と自動再送がないことを検証する。署名・Token・鍵・参加コードはメモリとIPCで扱い、assertionやファイル・成果物へ値を残さない。Goのjournalには従来どおり非秘密の確認hashだけを保存する。

実装前の追加試験は検証器が未存在のため失敗した。追加Go試験では合成参加コードの長さと、試験サーバーの中断待ちを修正した。製品側の検証や待機上限を緩めて成功させたものではない。修正後の結果を次に示す。

## 実行結果

2026-10-29、Node.js 24.22.1とGo 1.26.10を使ったローカル試験。実チューナー、本番Cloudflare、外部IdP、実録画には接続していない。

| コマンド | 結果 |
| --- | --- |
| `npm run check` | 成功。ルート23件、Phase 01は64件。Schema生成整合、TypeScript、整形、日本語コメント、Go vet・エラー処理検査、全Go race試験、公開前検査を含む |
| policy・Permitの対象10試験と`npm run lint` | 成功。用途選択のプロトタイプ継承拒否を加えた後に再実行 |
| `go test -race ./nodes/tuner/control -run CapturePolicy` | 成功。実TLS、本文待機上限、並行取得・中断・再開を含む |
| `npm audit --audit-level=moderate` | 既知の脆弱性0件 |
| `govulncheck ./...` | 既知の脆弱性0件 |
| Gitleaksの作業ツリー・全参照履歴検査 | 検出0件 |
| yomiyasuの静的検査・差分確認 | 実施。コードのコロン、変更ファイル一覧、用語「正本」は文脈を確認して維持 |

署名検証のコミットは、ステージ済み内容だけを書き出した別ディレクトリでも`contract:check`、`lint`、ルート23試験、Go wireのrace試験に成功した。これは公開前のローカル再現検証であり、本番の鍵運用や実配信の検収ではない。ブラウザとIaCの実行結果は対象コミットのCIで別に確認する。

## 未実装・未確認

Nodeのpolicy/Permitキャッシュと確定保存、巻き戻り拒否、オフライン再起動、鍵の供給Provider、実Scheduler、Backend登録・Storage Scope/Upload Grant、実録画・原本・canonical公開は未実装である。v1のcapture.startへこのpolicyを黙って適用せず、既存の未実装ACKも維持する。

D1での最終照合後や配信中にも状態は変わり得る。分断中の即時失効、物理exactly-once、バックアップ全体のrollback耐性は保証しない。現在のsnapshot保存は履歴を更新しないCASだが、管理者によるDB改ざんを防ぐ機能ではない。履歴の保持・GC、実環境のread replica・広域障害、本番移行と鍵運用も未検証である。

次はNodeでの確定保存と再起動時の照合を実装する。オフライン許可上限、対象OS、鍵保管、時計・キャッシュの復旧条件は引き続き入力が必要で、fixtureの値から本番設定を決めない。

## この変更のファイル一覧

署名検証とD1・HTTPS取得の二つのコミットに分けた。基点はPR #20の統合コミットで、変更・追加は43件。

- [CHANGELOG.md](../CHANGELOG.md)
- [apps/control/auth.ts](../apps/control/auth.ts)
- [apps/control/capture-policy.ts](../apps/control/capture-policy.ts)
- [apps/control/index.ts](../apps/control/index.ts)
- [apps/control/migrations/0003-capture-policies.sql](../apps/control/migrations/0003-capture-policies.sql)
- [contracts/capture-policy-v2.schema.json](../contracts/capture-policy-v2.schema.json)
- [contracts/control.schema.json](../contracts/control.schema.json)
- [docs/08-acceptance.md](../docs/08-acceptance.md)
- [docs/architecture/decisions/ADR-028-signed-capture-policy.md](../docs/architecture/decisions/ADR-028-signed-capture-policy.md)
- [docs/architecture/decisions/README.md](../docs/architecture/decisions/README.md)
- [docs/capture-permit-v2-verification.md](../docs/capture-permit-v2-verification.md)
- [docs/implementation-files.md](../docs/implementation-files.md)
- [docs/node-authorization-epoch.md](../docs/node-authorization-epoch.md)
- [docs/phase-01-progress.md](../docs/phase-01-progress.md)
- [docs/phase-01-runbook.md](../docs/phase-01-runbook.md)
- [docs/proposals/capture-permit-v2/README.md](../docs/proposals/capture-permit-v2/README.md)
- [docs/signed-capture-policy.md](../docs/signed-capture-policy.md)
- [nodes/tuner/cmd/policyfixture/main.go](../nodes/tuner/cmd/policyfixture/main.go)
- [nodes/tuner/control/capture_policy.go](../nodes/tuner/control/capture_policy.go)
- [nodes/tuner/control/capture_policy_test.go](../nodes/tuner/control/capture_policy_test.go)
- [nodes/tuner/control/provision.go](../nodes/tuner/control/provision.go)
- [nodes/tuner/wire/contracts_generated.go](../nodes/tuner/wire/contracts_generated.go)
- [nodes/tuner/wire/permit_v2.go](../nodes/tuner/wire/permit_v2.go)
- [nodes/tuner/wire/policy_v2.go](../nodes/tuner/wire/policy_v2.go)
- [nodes/tuner/wire/policy_v2_test.go](../nodes/tuner/wire/policy_v2_test.go)
- [packages/capture-permit/index.ts](../packages/capture-permit/index.ts)
- [packages/capture-permit/policy.ts](../packages/capture-permit/policy.ts)
- [packages/capture-permit/sign-policy.ts](../packages/capture-permit/sign-policy.ts)
- [packages/capture-permit/signature.ts](../packages/capture-permit/signature.ts)
- [packages/contracts/generated.ts](../packages/contracts/generated.ts)
- [packages/control-contracts/runtime.d.mts](../packages/control-contracts/runtime.d.mts)
- [packages/control-contracts/runtime.mjs](../packages/control-contracts/runtime.mjs)
- [scripts/generate-go-control.mjs](../scripts/generate-go-control.mjs)
- [scripts/generate-types.mjs](../scripts/generate-types.mjs)
- [scripts/test.mjs](../scripts/test.mjs)
- [tests/capture-policy.test.ts](../tests/capture-policy.test.ts)
- [tests/fixtures/permit-worker.ts](../tests/fixtures/permit-worker.ts)
- [tests/fixtures/policy-cases.ts](../tests/fixtures/policy-cases.ts)
- [tests/fixtures/policy-worker.ts](../tests/fixtures/policy-worker.ts)
- [tests/fixtures/policy.ts](../tests/fixtures/policy.ts)
- [tests/phase01/capture-policy.test.ts](../tests/phase01/capture-policy.test.ts)
- [tests/phase01/go-wire.test.ts](../tests/phase01/go-wire.test.ts)
- [tests/phase01/helper.ts](../tests/phase01/helper.ts)
