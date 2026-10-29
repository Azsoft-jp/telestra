// Mockの読取結果をtextContentで表示する。入力をHTMLとして展開せず、録画操作も行わない。
const messages = Object.freeze({
  empty: "録画はまだありません。",
  waiting: "原本は保存済みです。再生用の映像を準備しています。",
  failed: "処理を完了できませんでした。保存状況を確認してください。",
  disconnected:
    "接続が切れています。チューナー側の保存状況を確認してください。",
  reconnecting: "接続を確認しています。",
  forbidden: "この操作を行う権限がありません。",
  "mock-ready": "模擬変換の結果を取得しました。映像再生は未実装です。",
});
function element(id) {
  const value = document.getElementById(id);
  if (!value) throw new Error("画面の要素が見つかりません。");
  return value;
}
async function load() {
  const button = element("reload");
  button.disabled = true;
  element("status").textContent = "結果を取得しています。";
  try {
    const response = await fetch("/api/demo", {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("取得に失敗しました。");
    const value = await response.json();
    if (
      value.sourceBytes !== 2444 ||
      value.chunks !== 4 ||
      value.playback?.manifest?.playable !== false ||
      !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    )
      throw new Error("合成結果を確認できません。");
    element("bytes").textContent = value.sourceBytes.toLocaleString("ja-JP");
    element("chunks").textContent = String(value.chunks);
    element("hash").textContent = `SHA-256 ${value.sourceSha256}`;
    element("status").textContent = messages["mock-ready"];
  } catch {
    element("status").textContent =
      "結果を取得できません。Demoの起動状態を確認して再読込してください。";
  } finally {
    button.disabled = false;
  }
}
element("reload").addEventListener("click", load);
element("state").addEventListener("change", () => {
  element("example").textContent =
    messages[element("state").value] ?? "表示できません。";
});
element("example").textContent = messages["mock-ready"];
await load();
