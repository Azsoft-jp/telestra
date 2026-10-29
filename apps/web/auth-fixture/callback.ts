// callbackのアドレスを消してから通知する。認可結果や失敗の詳細をDOM・ログへ出さない。
import { relayCallback } from "../../../packages/browser-auth/callback.ts";
import { browserCallbackHost } from "../../../packages/browser-auth/window.ts";

document
  .getElementById("close")
  ?.addEventListener("click", () => window.close());
const outcome = await relayCallback(
  browserCallbackHost(window),
  window.location.origin + "/auth/callback",
);
const status = document.getElementById("callback-status");
if (status)
  status.textContent =
    outcome === "success"
      ? "元の画面へ認可結果を戻しました。"
      : "認可結果を戻せません。この画面を閉じ、元の画面からやり直してください。";
