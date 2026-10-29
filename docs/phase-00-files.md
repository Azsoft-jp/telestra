# Phase 00の変更ファイル一覧

Phase 00完了時点で、添付ZIPの内容と比較した一覧。以後のコメント修正とPhase 01の追加分は[現在の変更一覧](implementation-files.md)を参照する。空の作業ディレクトリへ展開した既存の設計資料は保持している。Gitは未初期化。`node_modules/`と生成した`artifacts/`は含めない。

変更3件、追加54件、削除0件。

## 変更した既存ファイル

- [README.md](../README.md)
- [docs/08-acceptance.md](../docs/08-acceptance.md)
- [scripts/validate_package.py](../scripts/validate_package.py)

## 追加ファイル

- [.github/workflows/ci.yml](../.github/workflows/ci.yml)
- [.gitignore](../.gitignore)
- [.prettierignore](../.prettierignore)
- [apps/api/capture.ts](../apps/api/capture.ts)
- [apps/api/index.ts](../apps/api/index.ts)
- [apps/api/package.json](../apps/api/package.json)
- [apps/api/repository.ts](../apps/api/repository.ts)
- [apps/web/index.ts](../apps/web/index.ts)
- [apps/web/package.json](../apps/web/package.json)
- [contracts/mock-capture.schema.json](../contracts/mock-capture.schema.json)
- [contracts/mock-playback.schema.json](../contracts/mock-playback.schema.json)
- [contracts/mock-requests.schema.json](../contracts/mock-requests.schema.json)
- [contracts/mock-tracks.schema.json](../contracts/mock-tracks.schema.json)
- [contracts/node-payloads.schema.json](../contracts/node-payloads.schema.json)
- [docs/architecture/decisions/ADR-011-phase00-mock-boundary.md](architecture/decisions/ADR-011-phase00-mock-boundary.md)
- [docs/architecture/decisions/ADR-012-contract-discrepancies.md](architecture/decisions/ADR-012-contract-discrepancies.md)
- [docs/phase-00-files.md](../docs/phase-00-files.md)
- [docs/phase-00-report.md](../docs/phase-00-report.md)
- [docs/phase-00-runbook.md](../docs/phase-00-runbook.md)
- [docs/phase-01-handoff.md](../docs/phase-01-handoff.md)
- [go.mod](../go.mod)
- [nodes/encoder/index.ts](../nodes/encoder/index.ts)
- [nodes/encoder/package.json](../nodes/encoder/package.json)
- [nodes/tuner/cmd/mock/main.go](../nodes/tuner/cmd/mock/main.go)
- [nodes/tuner/mock/backend.go](../nodes/tuner/mock/backend.go)
- [nodes/tuner/mock/backend_test.go](../nodes/tuner/mock/backend_test.go)
- [package-lock.json](../package-lock.json)
- [package.json](../package.json)
- [packages/contracts/generated.ts](../packages/contracts/generated.ts)
- [packages/contracts/index.ts](../packages/contracts/index.ts)
- [packages/contracts/package.json](../packages/contracts/package.json)
- [packages/storage/index.ts](../packages/storage/index.ts)
- [packages/storage/package.json](../packages/storage/package.json)
- [scripts/check-contracts.ts](../scripts/check-contracts.ts)
- [scripts/acceptance-gate.ts](../scripts/acceptance-gate.ts)
- [scripts/check-format.mjs](../scripts/check-format.mjs)
- [scripts/checkerrors/main.go](../scripts/checkerrors/main.go)
- [scripts/checkerrors/main_test.go](../scripts/checkerrors/main_test.go)
- [scripts/generate-types.mjs](../scripts/generate-types.mjs)
- [scripts/go-test.mjs](../scripts/go-test.mjs)
- [scripts/mock.ts](../scripts/mock.ts)
- [scripts/test.mjs](../scripts/test.mjs)
- [scripts/tuner-fixture.ts](../scripts/tuner-fixture.ts)
- [tests/cli.test.ts](../tests/cli.test.ts)
- [tests/acceptance.test.ts](../tests/acceptance.test.ts)
- [tests/contracts.test.ts](../tests/contracts.test.ts)
- [tests/evidence.ts](../tests/evidence.ts)
- [tests/fixtures/README.md](../tests/fixtures/README.md)
- [tests/fixtures/synthetic-ts.json](../tests/fixtures/synthetic-ts.json)
- [tests/fixtures/tracks.json](../tests/fixtures/tracks.json)
- [tests/output.test.ts](../tests/output.test.ts)
- [tests/pipeline.test.ts](../tests/pipeline.test.ts)
- [tests/storage.test.ts](../tests/storage.test.ts)
- [tsconfig.json](../tsconfig.json)

## 生成する検証記録

`artifacts/phase00-results.json`、`artifacts/go-results.json`、`artifacts/test-output.txt`、`artifacts/go-test-output.txt`、実行ごとの`artifacts/runs/`を生成する。これらはGit管理対象外で、CIでは検証証跡としてアップロードする。
