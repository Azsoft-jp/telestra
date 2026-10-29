# public clientのPKCEからAPIセッションまで

2026年10月29日のPhase 01追加実装を記録する。[ADR-023](architecture/decisions/ADR-023-browser-pkce-memory-session.md)に従い、短命Access Tokenをメモリへ持つpublic clientの認可コード交換を追加する。ログイン画面と実IdPは未実装・未検証で、Phase 01全体は未完了である。

## 実装した経路

packages/browser-authのBrowserSessionは、固定した公開設定をSchemaとURL条件で確認する。beginでstate・nonce・verifierを作り、S256を含む認可URLを返す。completeは、同じインスタンスで開始した固定callbackのURLだけを検証し、認可コードを一回だけ交換する。失敗したコード交換を自動再送しない。

ID Tokenはissuer、client IDのaudience、署名、期限、nonceを検証する。Access TokenはAPIのaudienceとat+jwt用途で別に検証し、同じ主体であることを確認する。APIの/sessionが現在の所属・失効・期限を確認してから、メモリ内の資格を確定する。リクエストからRoleを設定せず、毎回APIのD1台帳で認可する。

表示状態は未ログイン、待機、ログイン済み、期限切れ、権限なし、切断、失敗、ログアウトの失効未確認を日本語で返す。状態と期限だけを公開し、資格・verifier・コードをpublic fieldへ出さない。requestは固定API originの限定操作だけを受け付け、任意URLやNode専用のjoin/rotateへBearerを転送しない。

秘密値のファイル・Cookie・Web Storage保存、Refresh Token、サイレント更新は実装しない。別originのインスタンスと再読込後のインスタンスは、資格も進行中の認可も引き継がない。中断後の遅い応答は採用せず、同時要求を4件まで、応答を16KiB・5秒までに制限する。APIへの送信JSONは8KiBまでである。

## 再現と結果

承認済みの依存物を用意した開発環境で実行する。新しい外部依存物は追加していない。Go 1.26.10、Node.js 24.22.1を検証基準とする。

```sh
npm run control:build
node --experimental-strip-types --test tests/phase01/browser-auth.test.ts
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off npm run check
```

| 対象 | 結果と範囲 |
| --- | --- |
| 追加9試験 | macOS arm64で成功。Mock IdPがS256を照合し、発行した資格でローカルWorkerのAPIを呼ぶ |
| callbackの境界 | 別state・issuer・origin・パス、重複・未知クエリ、fragment、過大code、開始期限切れを交換前に拒否 |
| Tokenの境界 | nonce、ID/API用途、署名、issuer、audience、主体、期限、未知の権限・Refresh Tokenを拒否 |
| API認可と回復 | 403、接続復帰、所属失効による401、ローカル期限切れ、再読込、別originの再ログインを確認 |
| 中断とログアウト | 遅れた資格を採用せず、失効要求が未確認ならローカル破棄と未確認状態を返す |
| 上限 | 不正なContent-Type・キャッシュ設定、redirect、過大応答、停止したstreamを拒否。同時4件と中断後の回収を確認 |
| npm run check | 修正後の最終実行は終了コード0。既存16試験、Phase 01の36試験、Go全体のrace、型・Schema生成差分・書式・日本語コメント・公開前検査が成功 |
| Gitleaks | 作業ツリーと全refの履歴で検出0件。値はredactする |
| govulncheck ./... | Go 1.26.10で検出0件 |

未実装の入口で最初の契約試験が失敗することを確認してから実装した。初回の型検査でMiniflareと標準Headersの差が見つかり、標準のヘッダー表現へ変換した。redirectの拒否試験も一度失敗し、明示的な拒否へ修正して再実行した。最終レビューでは、成功応答のセッションSchema違反で資格が残る問題を9件目の試験で再現した。通信断の扱いを保ちつつ、成功応答の構造・主体不整合では資格を破棄するよう修正した。追加文書の公開前検査では、OIDCの節番号をIPとして拾う誤検出が1件あった。対象は公開仕様の参照名で、実IPの漏えいではない。参照先を維持して節名で記載し直し、再検査して検出0件を確認した。

## 変更と限界

追加した手書きコードはpackages/browser-authのindex.ts、transport.ts、package.jsonと、tests/phase01のbrowser-auth.test.ts、mock-oidc.tsである。認証Schemaと生成型・検証器・Go埋込Schema、ID Tokenの用途検証、共通fixture、lockfile、実行記録・進捗・索引を更新する。[全変更一覧](implementation-files.md)でも追跡する。既存のNode命令と資格、D1の台帳形式は変えない。

検証はfetchを注入したMock IdPのprotocol試験である。実ブラウザの画面遷移、popup、postMessage、CORS、CSP、PWA、実IdPの挙動は未検証である。全面遷移でメモリを失う実装を完成済みと扱わず、UI側の戻し方とorigin/source検証を追加する必要がある。アクセストークンをメモリへ置く方式にはXSSによる窃取の残リスクがある。

ローカルprofileは固定Ed25519鍵と限定claimsを使い、任意のIdPに対応するものではない。実IdP、client登録、callback URI、対象ブラウザ、JWKS更新、IdP全体の失効を次の入力とする。Nodeの本番KeyProviderとOS復旧、実録画・視聴・字幕・PWAも引き続き未実装または未検証である。
