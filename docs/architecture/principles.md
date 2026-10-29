# 設計原則

TunerNodeは軽量に保つ。Mirakurun/mirakcの既存APIからTSと番組情報を受け、有限のスプールと予約キャッシュを扱う。FFmpeg、独自EIT解析器、DB、WebUIを追加する場合は、必要性を検証してADRを提案する。

EncodeNodeは独立させる。事後エンコードから検証し、ライブ、能力割当、Lease、再試行、フォールバックを段階的に追加する。処理できない場合を成功扱いせず、原本と字幕・音声情報を保持して変換待ちを示す。

StorageAdapterはR2を第一実装とし、S3等の差はAdapter内のcapabilityで明示する。原本チャンクはimmutableとし、長さとhashを確認してからmanifestへ載せる。再生用セグメントと原本、ARIB字幕の生情報と表示用データを分ける。DRCS、ルビ、色、位置、消去、文字スーパーの保持はgolden fixtureで確認してから対応を宣言する。

制御、媒体転送、保存を分ける。WSSはallowlistされた型付き制御だけとし、署名、期限、家庭・環境・資格世代・接続世代、サイズを検証する。Shell、任意URL取得、任意ファイル書込を追加しない。再接続は有限のbackoffとjitterを使い、認証・形式違反では停止する。詳しくはADR-014〜016を参照する。

予約intentと台帳はDurable Storeへ保存する。DOのメモリは正本ではない。Queueの重複・順序不定とネットワーク分断を想定する。同じ予約を複数Nodeが録画する可能性を残し、recordingId、attemptId、epochで原本を分離する。物理的なexactly-onceを約束しない。公開するcanonicalを一つへ収束させ、結果不明を自動再実行しない。

サーバレスを制御プレーンへ優先し、長時間の媒体処理は専用Nodeで扱う。転送量、保持期間、スプール容量、再試行、監査保持を費用と運用の単位として測る。互換性のないサービスを無理に共通化せず、必要なAdapterと移行手順でロックインを管理する。

Web/PWAは日本語で空、待機、失敗、切断、復帰、権限なしを表示する。端末保存は前景・再開可能な処理とし、OSによる停止や容量制限を説明する。別originのCookie、Service Worker、OPFS、IndexedDBは共有しない。

frontend dual-staticは、同一のimmutable成果物をCloudflare Workers Static Assetsと独立した二次配信元へ置く設計である。これはWeb配信の冗長化であり、API・認証・DB・原本の全面冗長化ではない。予備Webが表示できてもbackendの復旧とは呼ばない。RPO/RTOは復旧試験で測定する。

最小権限、短命資格、失効、構造化された監査、有限の負荷、失敗を検出できる応答を設計へ含める。秘密値はログやStateへ残さない。実装結果は[受け入れID](../08-acceptance.md)と実行証跡で追跡し、未実施の試験を合格と書かない。
