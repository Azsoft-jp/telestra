# 設定と秘密情報

Telestraが定義する環境変数とWorker BindingはTELESTRA_で始める。PATH、GOPROXY、GOSUMDB等の外部ツールの標準変数は変更しない。現在のDemoは環境変数を必要とせず、固定した合成fixtureだけを読む。

```sh
npm run telestra -- demo --port 5173
npm run telestra -- mock --profile examples/deployment.local.json --backend mirakc
```

プロファイル例のlocalhost originは構造の検査用で、Mockが接続する先ではない。development/local、primaryStorage:local、redundancy:noneを使用する。liveStreamingやofflineLibraryをtrueにしても実装は増えず、起動時に拒否される。spoolMaxBytesはMockの容量境界の検証に使い、指定容量の実ディスクを確保しない。

| 構成名 | 内容 | 現在の供給元 |
| --- | --- | --- |
| TELESTRA_ENVIRONMENT | development/staging/production | ローカル試験はdevelopmentだけ |
| TELESTRA_TENANT_ID | 家庭・テナント境界 | 合成のdemo-household |
| TELESTRA_ALLOWED_ORIGINS | 許可OriginのJSON配列 | メモリ内fixture |
| TELESTRA_OIDC_ISSUER / AUDIENCE / JWKS | 利用者Tokenの発行元・宛先・公開鍵 | Mock IdPのfixture |
| TELESTRA_CONTROL_ISSUER / PUBLIC_JWKS | Node制御の発行元・公開鍵 | メモリ内fixture |
| TELESTRA_CONTROL_PRIVATE_JWK | 制御署名用秘密鍵 | 試験時だけ生成。本番はSecret供給を設計 |
| TELESTRA_DB / TELESTRA_REGISTRY | D1とDOのBinding | Miniflareの一時領域 |
| TELESTRA_EVIDENCE_DIR / COMMIT / SOURCE_DIGEST / TEST_ENVIRONMENT | 試験証跡の出力・識別 | 試験Runnerが設定 |

表のOIDC名は全てTELESTRA_OIDC_AUDIENCE、TELESTRA_OIDC_JWKSのように接頭辞を含む。CONTROL側も同様である。古いTV_*とPH00_*は未公開の内部設定だったため移行aliasを設けない。JWTの用途やSchema IDは互換性のため維持する。詳細は[名称変更ADR](architecture/decisions/ADR-017-telestra-public-readiness.md)にある。

秘密値を.env.example、例示JSON、GitHub Issue、スクリーンショット、ログ、Terraform Stateへ入れない。非公開リポジトリも秘密の保管先ではない。実ドメイン、宅内DNS、IP、Zone/Tunnel/Bucketの識別情報は公開例へ転記せず、例示用の名前へ置き換える。秘密を扱う実運用設定は現在提供していない。
