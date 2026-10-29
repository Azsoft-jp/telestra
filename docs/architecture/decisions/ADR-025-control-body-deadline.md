# ADR-025 制御APIの本文読み取りの制限

Phase 01のローカルWorkerとDOで採用する。既存の8KiB制限に本文全体の読取期限と中断を加える。本番のWAF・認証基盤・Capture Permitの仕様は今回決定しない。

## 理由と決定

従来のWorkerは実読取量を制限していたが、reader.readの途中停止に期限がなかった。DOはrequest.textで全体を読んでからサイズを検査していた。[Workersの制限](https://developers.cloudflare.com/workers/platform/limits/)では、クライアントが接続しているHTTPやDOの呼出しに固定のwall time上限がない。本文の上限はアプリ側でも設ける。

apps/control/body.tsを両入口で使う。本文の読取開始から全体5秒、実量8192バイト、readの呼出し16384回を上限とする。chunkが届いても期限を延長せず、timerが実行される前に期限を過ぎた入力も時計で照合する。空chunkでmicrotaskが続く場合も、読み取り回数で停止する。この値はローカル制御JSON向けで、媒体転送には使わない。

JSONのContent-Type、Content-Lengthの形式・上限・実量との一致、UTF-8を検査する。圧縮された本文は受け付けない。Schemaと認証・認可は従来どおり呼出元が担い、本文の成功だけでは更新や命令の実行を許可しない。

途中停止は408、サイズ・読み取り回数の上限は413、不正なJSONや中断は400、非JSONや圧縮は415を返す。本文とsourceの例外は応答へ含めない。中断・失敗では未完のstreamへcancelを一度要求し、timer・abort listener・readerのlockを回収する。cancelのPromiseが終わらなくても拒否応答を待たせ続けない。正常時にreaderを解放できない場合は503とし、成功扱いにしない。

ローカルfixtureへenable_request_signalを明記する。[Request.signalの仕様](https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/)に従い、中断通知を使える構成とする。通知がない場合でも5秒の期限を維持する。Node側の時計・timer・signalは合成試験で差し替える内部依存で、HTTPから上限を変更する機能は設けない。

Workerが検査済みJSONをDOへ再シリアライズする際は、元のContent-Length・Content-Encoding・Transfer-Encodingを削除する。元の表現の長さを新しい本文へ引き継がず、DOでも新しい本文を同じ制限で再検査する。

## 代替案とトレードオフ

基盤のタイムアウトだけに任せる案は、呼出しが残り続ける条件を制限できないため採用しない。chunkごとに待機期限を戻す案は、少量を送り続ける入力で全体が延びるため採用しない。cancelの完了まで待つ案も、上流の終了処理で拒否応答が止まるため採用しない。

長い受信や16384回を超える読み取りは、総バイト数が少なくても拒否する。実回線・Proxyでの正当な要求への影響は別途測定する。JSONの拒否後にtransport全体の解放が完了したことや、既に確定したD1更新の取消しを保証する仕組みではない。

## 試験と見直し条件

CORE-02とSEC-10で、分割UTF-8、8192バイト境界、長さ不一致、圧縮、空chunk、途中停止、sourceエラー、cancelの停止・失敗、中断、reader解放失敗を検査する。実loopback HTTPでは約5秒の408とD1未更新、次の正常要求を確認する。DOへ渡す空白付きJSONも配送と再送を確認する。

これは本文読み取りの試験で、認証前のCPU・D1待機、同時接続数、地域的な負荷、実クライアント切断後の基盤解放、本番のWAF・DoS耐性を証明しない。実環境や大きなAPI入力へ進む際に、本文の期限・分割数・signalの構成と観測方法を見直す。
