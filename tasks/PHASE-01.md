# Phase 01 — Node Identity / WS Control / Auth

## 実装

1. `TunerNode`/`EncodeNode`のjoin/issue/rotate/revoke、能力登録とHeartbeat。
2. Node outbound WSS + DOによるconnection registry。接続世代、resumption、指数backoff+jitter、過負荷時backpressure。
3. OIDC/PWA利用者用API session、RBAC/resource-level authorization。Staging IdPやMock IdPを用いて自動テスト。
4. `hello`, `heartbeat`, `capture.start`, `capture.cancel`, `command.ack`のtype別Schema/署名/期限検証。自由なshellコマンドは実装しない。
5. Token失効・WebSocket Origin・CSRF・SSRF防御、負荷/サイズ上限。
6. WSSのcontrolと動画データのtransferを分離。

## 完了条件

- `NODE-01/02`, `CORE-02`, `SEC-01/02/03/04`がpass。
- BrowserとNodeのcredentialを混同しない。
- Nodeが切断しても永続予約/録画情報が失われない。
- 実環境でWSS実接続をテストしていない場合は未検証として報告。
