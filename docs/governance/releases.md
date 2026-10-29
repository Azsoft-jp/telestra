# リリースと互換性

現在のパッケージは0.0.0で開発中である。npm公開と安定版リリースは行わない。最初の配布物も、動作範囲をMock・契約試験と明記する。Releaseが存在する前に成功や版を示すバッジを掲示しない。

公開するタグはcommitへ固定し、後から付け替えない。変更履歴、実行した検査、未検証のOS・機器、依存一覧、ライセンス、成果物のhashを添える。PRIVATEはタグを解決したSHAを固定する。互換性を壊す契約変更はADRと移行手順を先に作る。

今回の名称変更は未公開のnpm名、Go import、CLI、内部の試験用環境変数を変更する。既存のnpm run mockは維持する。JWTのtyp/audience、X-TV-Device-Proof、Schemaの$id、protocolVersion:1、履歴形式version:1は維持する。文字列の一括置換で既存資格を別用途へ変えない。将来変更する場合はv2として並行受付期間、失効、移行、拒否条件を定める。

依存はlockfileとgo.sumで固定し、Dependabotの更新PRを週次で受ける。Actionはcommit SHAを固定する。脆弱性の重大度だけでなく、到達可能性、利用箇所、更新の影響を確認する。検査失敗を理由なく無視する設定は追加しない。例外には期限、理由、範囲、代替策を記録する。

ソースrollbackとデータ復元は別の操作である。Workerは既知の版へ戻せても、DBの破壊的移行は元へ戻せない。移行はexpand→deploy→contractとし、バックアップ、復元試験、承認を揃えてから実施する。実環境の手順はPhase 06以降に検証する。

## 2026年10月29日の依存修正

npm auditでfast-uri、sharp、undiciとその親のMiniflareに既知の問題を検出した。fast-uriは3.1.9へ更新し、Miniflareが固定するsharpを0.35.5、undiciを7.30.1へoverridesで固定する。親の公開最新版も古い固定依存だったため、同じ互換系列の修正版を選んだ。自動のforce downgradeは使わない。

根拠は[fast-uri](https://github.com/advisories/GHSA-w74x-v6f9-j3xg)、[sharp](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)、[undici](https://github.com/advisories/GHSA-2m5v-pch6-74hx)の公式アドバイザリである。Worker/D1/DO/Go WSSの契約試験を再実行する。親が修正版を採用した場合はoverridesを外せるか再検証する。

Go 1.26.8でgovulncheckの通常出力を実行し、標準ライブラリに到達可能な10件を検出した。修正版のGo 1.26.10を公式配布物のSHA-256と照合し、検証・CIの基準にする。go.modの言語互換性の最低値1.23を、安全性が確認済みの推奨版とは解釈しない。根拠は[Go脆弱性データベース](https://pkg.go.dev/vuln/GO-2026-6809)と[公式配布](https://go.dev/dl/)を参照する。JSON出力の終了コードだけを合格判定に使わず、通常のgovulncheckの終了コードも確認する。
