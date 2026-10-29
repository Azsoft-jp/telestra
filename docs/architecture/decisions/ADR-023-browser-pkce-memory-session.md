# ADR-023 public clientのPKCEとメモリ内セッション

Phase 01のローカル実装として採用する。[セキュリティ設計](../../04-security.md)の、originごとに短命Access Tokenをメモリへ保持する方針を具体化する。本番IdP、ログイン画面、認可結果を画面へ戻す方式は未決定・未実装のままである。

## 理由と決定

既存の利用者APIは、試験側で直接発行したBearerを検証していた。PKCEの認可コード交換から同じAPIへ到達する経路を追加し、nonce、用途、現在の所属・失効まで検証する。Cookieを共有するBFFへの変更は今回の範囲に含めない。

[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html)に基づき、開始ごとに256bitの乱数からverifier、state、nonceを作り、S256だけを使う。verifierと進行中の状態はメモリへ保持し、開始の有効時間は120秒とする。[RFC 9700](https://www.rfc-editor.org/info/rfc9700/)のPKCE利用とdowngrade防止の指針を参照し、plainへのfallbackや交換の自動再送を設けない。

固定したHTTPSの認可・Token endpoint、redirect URI、API origin、issuer、公開鍵を構成する。認可応答の重複・未知クエリ、fragment、別redirect URIを拒否する。stateと、[RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html)のissを開始時の構成と照合する。応答やToken内のURLから接続先・鍵を取得しない。

[OpenID Connect CoreのID Token検証](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)を参照し、署名、issuer、client IDのaudience、期限、nonceを照合する。APIのAccess Tokenは別のaudienceとat+jwt用途で検証し、ID Tokenとの主体の一致も確認する。さらにAPIの現在の所属・失効を確認してからログイン済みとする。ID Tokenの任意のjtiを必須にせず、既存のAPI・Node資格のjti必須条件は維持する。

Access Tokenはprivate fieldへ保持する。ID Tokenは検証後に保持せず、Refresh Token、Cookie、Web Storage、Service Workerへの保存を追加しない。再開始・中断の後に届いた応答は採用しない。ログアウトはAPIでの失効を一回だけ要求し、応答が不明ならローカル破棄とサーバー側の失効未確認を区別する。IdP全体のログアウトを保証しない。

## 代替案とトレードオフ

Cookie/BFFはXSSからTokenを隔離する利点があるが、既存のdual-static設計を変更するため別ADRで評価する。verifierをsessionStorageへ残す方法は全面遷移の実装を簡単にするが、今回は秘密値をメモリに置く入口を実装する。画面を再読込すると認可途中の状態も失い、再ログインが必要になる。

この実装は、ADR-013のEd25519と固定公開鍵、単一audience、限られたclaimsを使うローカルMock profileである。任意のIdPへの互換性やOIDC全体への準拠は宣言しない。RS256、複数audience、at_hash、Discovery、JWKS更新、追加のID claimsは実IdP選定後に契約と否定試験を追加する。未知項目を黙って読み飛ばして対応済みとは扱わない。

## 試験と見直し条件

SEC-04、SEC-01、CORE-02で、既知のS256 vector、state・nonce・用途・署名・主体・期限、APIの権限と失効、別origin・再読込の分離、途中中断、ログアウト未確認を検証する。通信はCookie・キャッシュ・redirectを使わず、応答16KiB、5秒、同時4要求に制限する。

fetchを注入したMock IdPと実際のローカルWorkerを使う。実ブラウザの遷移、popup、postMessage、CORS、CSP、PWAの確認は別試験とする。popupの採用時はoriginとsourceの完全一致確認を入口の前で必須にする。本番IdP、各originのclient登録とcallback、対象ブラウザ、公開鍵更新・失効方針が決まった時点で見直す。
