# PRIVATE側の初期構成

PUBLICの固定SHAをsource.lock.jsonへ記録する。schemaは[source.lock.schema.json](source.lock.schema.json)にある。実ファイルは非公開側へ置き、PUBLICへ環境固有設定を戻さない。

開発・検証・本番を分け、未設定の環境はconfigured:falseとする。Token、秘密鍵、実証明書、State、ログ、録画を保存しない。実apply/deploy workflowは現在提供しない。保護環境、承認、短命OIDCの対応、資源のplan、復旧とrollbackを確認してから追加する。
