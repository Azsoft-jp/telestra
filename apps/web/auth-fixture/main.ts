// 認証fixtureの状態だけをtextContentで表示する。認可URL・資格・ライブラリ例外を表示しない。
import { PopupLogin } from "../../../packages/browser-auth/popup.ts";
import { browserPopupHost } from "../../../packages/browser-auth/window.ts";
import { validateControl } from "../../../packages/control-contracts/index.ts";
import { readResponse } from "../../../packages/browser-auth/transport.ts";

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error("表示要素がありません。");
  return value;
}
function button(id: string): HTMLButtonElement {
  const value = element(id);
  if (!(value instanceof HTMLButtonElement))
    throw new Error("操作要素がありません。");
  return value;
}
let flow: PopupLogin | undefined,
  busy = false,
  expiry: number | undefined;
const roleText = {
  viewer: "視聴者",
  recorder: "録画利用者",
  operator: "運用担当",
  admin: "管理者",
} as const;
function render() {
  if (!flow) return;
  const state = flow.snapshot;
  element("auth-status").textContent = state.message;
  element("auth-status").dataset.state = state.state;
  const pending = ["opening", "waiting", "exchanging"].includes(state.state);
  button("login").disabled = busy || pending || state.expiresAt !== null;
  button("cancel").disabled = !pending;
  button("session").disabled = busy || state.expiresAt === null;
  button("logout").disabled = busy || state.expiresAt === null;
  if (state.expiresAt === null) element("user-status").textContent = "";
}
function scheduleExpiry() {
  window.clearTimeout(expiry);
  const end = flow?.snapshot.expiresAt;
  if (end)
    expiry = window.setTimeout(
      render,
      Math.max(0, end * 1000 - Date.now()) + 10,
    );
}
try {
  const response = await readResponse(
    fetch,
    window.location.origin + "/auth/config",
    {},
    new AbortController(),
  );
  if (response.status !== 200) throw new Error("公開設定を取得できません。");
  const config = validateControl("OidcPublicConfig", response.value);
  flow = new PopupLogin(config, browserPopupHost(window));
  button("login").addEventListener("click", () => {
    if (!flow || busy) return;
    // ユーザー操作の同期区間で呼び、popup blockerをasync処理で回避しようとしない。
    const completed = flow.login();
    busy = true;
    render();
    const progress = window.setInterval(render, 250);
    void completed
      .then(async () => {
        if (!flow) return;
        const user = await flow.session();
        element("user-status").textContent =
          `合成ユーザー ${user.subject} / 権限 ${roleText[user.role]}`;
      })
      .catch(() => {
        /* 失敗はFlowの日本語状態で表示し、例外本文やURLを表示しない。 */
      })
      .finally(() => {
        window.clearInterval(progress);
        busy = false;
        render();
        scheduleExpiry();
        if (document.hasFocus())
          button(flow?.snapshot.expiresAt ? "session" : "login").focus();
      });
  });
  button("cancel").addEventListener("click", () => {
    flow?.cancel();
    render();
  });
  button("session").addEventListener("click", () => {
    if (!flow || busy) return;
    busy = true;
    render();
    void flow
      .session()
      .then((user) => {
        element("user-status").textContent =
          `合成ユーザー ${user.subject} / 権限 ${roleText[user.role]}`;
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
        render();
      });
  });
  button("logout").addEventListener("click", () => {
    if (!flow || busy) return;
    busy = true;
    render();
    void flow
      .logout()
      .catch(() => {})
      .finally(() => {
        busy = false;
        render();
        window.clearTimeout(expiry);
      });
  });
  window.addEventListener("pagehide", () => {
    window.clearTimeout(expiry);
    flow?.dispose();
  });
  render();
} catch {
  element("auth-status").textContent =
    "公開設定を確認できません。fixtureを再起動してください。";
  element("auth-status").dataset.state = "failed";
}
