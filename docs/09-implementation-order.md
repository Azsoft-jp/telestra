# 09 / 実装ステップと依存関係

## Vertical sliceを先に作る

画面全部、API全部、IaC全部を横断的に一気に作らない。モックで以下の流れが通るまで小さく維持する。

1. MockMirakurunに偽のサービス/番組表/TSを持たせる。
2. Node Registryの型付き接続/認証（最初はローカル開発資格）を作る。
3. TunerNodeが原本TSをimmutable chunkにし、fake storageへPUTする。
4. Storeがhash/lengthを検証し、attempt manifestへ公開する。
5. Mock EncodeNodeがmanifestを読み、合成字幕sidecarつきのダミーrenditionを登録する。
6. 認可済みPlayback APIが正しいmanifestを返し、UIの状態へ反映する。

これがPhase 00〜02の基礎。実メディア/実GPU/実Cloudflareは契約が固まった後に切替。

## Phaseと成果物

| Phase | 主な変更 | 検証 |
| --- | --- | --- |
| 00 | Mono repo、Protocol Schema、Mock、CI | Contract + simulate |
| 01 | Node identity/Registry/WS control | Auth negative + reconnection |
| 02 | Tuner Agent + immutable recording + StorageAdapter | hash+split-brain+retry |
| 03 | EPG+reservation+scheduler | EIT/Programs diff/extend/conflict |
| 04 | Encode Node+subtitle+playback | fixture + seek + fallback |
| 05 | PWA+SAP UI+Offline Library | E2E+responsive+security |
| 06 | IaC/Wrangler/dual-static | plan+staging+digest+fallback |
| 07 | Monitoring/DR/security hardening | drills+threat tests |

スコープを縮める場合はPhase 04までの録画再生の完成を優先し、クラウド冗長や複数Providerを後回しにする。ただしProvider境界・Audit・Authenticatonの契約は残す。

## フィーチャーフラグ

| フラグ | 初期値 | 意味 |
| --- | --- | --- |
| `live_streaming` | false | 録画後の再生から開始 |
| `post_encode` | true | 事後変換 |
| `dual_static_frontend` | false | 本番準備後に有効化 |
| `local_offline_library` | false | 検証済み端末から有効化 |
| `storage_replica` | false | レプリカ監視を実装後に有効化 |
| `multi_tenant` | false | 別セキュリティ審査まで禁止 |

機能フラグの場所は環境ごとの設定を正本とし、UIローカル変更で認可を変更できないようにする。

## 実装後に毎回報告する内容

1. 今回のタスクID・PR/commit・変更点。
2. 実行した試験ID、pass/fail/skip、再現方法。
3. 実機/ブラウザ/ネットワーク依存の未検証項目。
4. セキュリティ・データ喪失・権限・費用上の変化。
5. 次Phaseへ進める条件。
