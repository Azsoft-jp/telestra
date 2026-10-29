// 本体の視聴UIに向けて、日本語の状態表示と別originの制約を定義する。
export type MockViewState =
  | "empty"
  | "waiting"
  | "failed"
  | "disconnected"
  | "reconnecting"
  | "forbidden"
  | "mock-ready"
  | "not implemented";
export const stateText: Readonly<Record<MockViewState, string>> = Object.freeze(
  {
    empty: "録画はまだありません。",
    waiting: "録画は保存済みです。再生用の映像を準備しています。",
    failed:
      "処理を完了できませんでした。保存状況を確認して再試行してください。",
    disconnected:
      "接続が切れています。チューナー側の録画状況を確認してください。",
    reconnecting: "接続を確認しています。",
    forbidden: "この操作を行う権限がありません。",
    "mock-ready": "模擬変換の結果を取得しました。映像再生は未実装です。",
    "not implemented": "この機能はまだ利用できません。",
  },
);
export const frontendStatus = Object.freeze({
  implementation: "not implemented",
  originIsolation:
    "別originのログイン、Service Worker、OPFS、IndexedDB、Cookieは引き継ぎません。",
  backendRecovery: "予備サイトの表示はAPI・認証・データの復旧を意味しません。",
});
