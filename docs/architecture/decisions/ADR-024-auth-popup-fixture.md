# ADR-024 認可結果を返すpopupのローカル検証

Phase 01のローカルfixtureとして採用する。[ADR-023](ADR-023-browser-pkce-memory-session.md)のpublic clientを保持した画面と、認可結果を返すwindowを結ぶ。本番IdP、PWAでの方式、BFFへの移行は今回決定しない。

## 理由と決定

画面を全面遷移するとメモリ内のverifierと開始状態を失う。今回は、ユーザー操作の同期区間でpopupを一つ開き、元の画面にpublic clientを保持する。非同期の暗号処理が終わってからwindow.openする方法には依存しない。開けない、閉じられた、中断、120秒の期限切れ、失敗を区別する。

[HTML Standardのcross-document messaging](https://html.spec.whatwg.org/multipage/web-messaging.html#security-9)に従い、postMessageはoriginとデータ形式を照合し、機密のある通知にwildcardのtargetOriginを使わない。加えて、開いたWindowProxyとのsourceの同一性を確認する。固定callbackのURI、開始state、issuer・nonceは既存のPKCE処理で照合する。別origin・別windowはデータの検証やHTTP要求を始める前に無視する。

callbackページはURLからqueryをhistory.replaceStateで消してから一回だけ通知する。通知には検証対象の認可コード・state・issuerを含むcallback URLを渡し、Access TokenとID Tokenは含めない。元のwindow・origin・stateに束縛したACKを待ち、ACKの待機は15秒に制限する。ACKを確定してlistenerを除去してから閉じ、pagehideで成功が失敗へ変わる競合を防ぐ。親も成功後500msでwindowの回収を試みる。

最初のChromium試験では、callbackにも親と同じCOOPを設定するとopenerが切れ、閉じたWindowProxyとToken要求0件を確認した。[COOPのブラウザ動作](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)を参照し、ローカルfixtureでは親をsame-origin-allow-popups、通信専用callbackをunsafe-noneとする。この組み合わせで再試験し、元のwindowへの通知を確認した。一般的なIdPや別ブラウザへの互換性は保証しない。

## 代替案とトレードオフ

verifierをWeb Storageへ置く全面遷移は、ADR-023のメモリ保持を変更するため採用しない。BFF、BroadcastChannel、複数タブの共有セッションも今回追加しない。popupはユーザー操作とブラウザの許可に依存し、IdPのCOOPで参照が切れる場合がある。参照が切れた際に、別windowや資格の保存へfallbackしない。

callbackのCOOP例外は、同じoriginの通信専用ページと厳しいCSP、no-store、no-referrerを組み合わせるローカル判断である。本番へそのまま転用せず、実IdPの信頼、reverse tabnabbing、追加の分離、戻し方をレビューする。URIの消去はブラウザ内部のすべての履歴やOS記録の消去を保証しない。

## 検証と見直し条件

Window fixtureではorigin・source・Schema、再利用、同時開始、拒否・終了・期限・破棄、ACKとpagehide、設定途中の失敗を検証する。実Chromiumでは4つのloopback TLS originでPKCEとAPIを結び、CORS、別origin・再読込の分離、手動終了、中断、認可URLの消去を確認する。日本語、キーボード、320/768/1200幅もauth fixtureの範囲で検査する。

通常の通信をPlaywrightで横取りするとpreflightの観測が変わるため、CORS試験はnative通信で行う。外向き通信は転送しないローカルproxyで拒否し、Workerも外向きfetchを拒否する。Miniflare自身のRequest.cf補完もcf:falseで止める。手動CLIは専用の子process groupでfixtureを持ち、型を限定したIPCで非同期停止を確認する。依存ツールのsignal hookで後始末を飛ばさない。自己署名TLSを許容するのは、非永続の試験contextだけである。trace、HAR、動画、storageState、TLS鍵ログを保存しない。親画面の合成データだけを画像へ記録する。

実IdPとcallback登録、対象ブラウザ・PWA、COOP/CSP、MFA、公開鍵更新を次の入力とする。実環境TLS、全画面のWCAG、XSS侵入試験、PWA、実録画・再生、本番KeyProviderは別の検証を要する。
