# 別Goプロセスでの資格復元と更新途中の強制終了

2026年10月29日のPhase 01追加試験を記録する。[ADR-022](architecture/decisions/ADR-022-node-process-restart-fixture.md)に従い、同一プロセスでの再初期化に加えて、実際に異なるGoプロセスを起動する。本番の鍵保管・供給Providerは未実装で、Phase 01全体も未完了である。

## 確認する境界

正常系では、最初のGoがjoin/rotateし、loopback WSSへ接続して終了する。親試験は専用IPCで受け取った合成資格を検証してメモリへ保持する。次のGoには同じ非秘密履歴と最後の資格を渡し、復元後のWSS接続世代が1から2へ進むことを確かめる。旧資格と別鍵は接続前に拒否し、履歴を削除してやり直さない。失効後の停止も確認する。

障害系では、実際のローカルWorkerがrotateを確定した後、TLSの障害注入サーバーが応答を保留する。親がGoへSIGKILLを送り、終了signalを確認する。別のGoはOSロックを取得できるが、pending履歴から旧資格を復元できず、recovery-requiredで終了する。Workerの世代は更新済みのままで、追加HTTPとWSS接続は発生しない。自動再参加は行わない。

秘密鍵、資格、参加コードはファイル・環境変数・証跡へ保存しない。FD3は専用Unix socketだけを受け付け、通常ファイルなどを拒否する。共有履歴の入力は固定形式のIDだけとし、任意パスを受け付けない。stdoutの進捗も既知の項目と値だけを許可する。外向きfetchは0回である。

## 再現と実行結果

既存の承認済みGo依存物をキャッシュした開発環境で実行する。Go 1.26.10とNode.js 24.22.1を検証基準とし、依存物の追加取得は不要である。

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go test -race ./nodes/tuner/cmd/controlfixture -count=1
npm run control:build
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off node --experimental-strip-types --test tests/phase01/go-restart.test.ts
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run check
```

| 対象 | 結果と範囲 |
| --- | --- |
| NODE-02の別プロセス復元 | macOS arm64で成功。旧資格・別鍵を拒否し、最後の資格で接続世代1→2、失効後停止を確認 |
| SEC-02の更新後SIGKILL | macOS arm64で成功。Workerの更新成立、SIGKILL、pending保持、別プロセスの復元拒否、追加要求0件を確認 |
| Goの試験境界 | race付きで成功。共有領域のID・権限・symlink・通常ファイル、資格のファイル出力を拒否 |
| npm run check | 終了コード0。既存16試験、Phase 01の27試験、Go全体のrace、型・Schema生成差分・書式・日本語コメント・公開前検査が成功 |
| Gitleaks | 作業ツリーと全refの履歴を別々に検査し、どちらも検出0件。値はredactする |
| govulncheck ./... | Go 1.26.10で検出0件 |

証跡はartifactsのPhase別レポートと実行ログへ保存する。対象の2試験だけを実行した結果と、全体検査の結果を区別する。資格IPCをUnix socketへ限定した後、TCP出力の否定試験を追加し、Goのrace・型検査・2つの相互試験も再実行して成功した。日本語コメントと文書はyomiyasuで推敲し、静的検査と差分確認を行う。

## 変更ファイル・限界・次の入力

Goの固定試験コマンドへ共有領域と専用IPCを追加し、その拒否条件をmain_test.goへ記録した。WSS試験の起動処理はgo-agent.tsへ移し、別プロセス試験をgo-restart.test.ts、障害注入をrotate-barrier.tsへ分けた。試験レポートの範囲、ADR索引、進捗、実行手順、変更履歴と[全変更一覧](implementation-files.md)も更新する。本体の資格検証・履歴形式・wire形式は変更しない。

親のメモリは試験専用であり、親自体が終了すると資格を失う。この試験はGoのプロセス境界を確認するもので、OS再起動や本番環境の復旧を保証しない。電源断、ディスク停止、履歴全体の巻き戻り、実クラウドWSS、実EncodeNodeは未検証である。PKCEのログイン画面、実録画・再生・字幕・PWAもこの変更に含めない。

次に必要な入力は、TunerNode／EncodeNodeの対象OS、鍵と資格の保管方式・供給経路、更新と復旧の権限である。本番方式の決定や秘密値の取得・保存は、Mock試験の成功から自動的に進めない。
