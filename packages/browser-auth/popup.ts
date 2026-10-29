// public clientを保持したままpopupの認可結果を返す。originとwindowの両方を照合する。
import { BrowserSession } from "./index.ts";
import { parseCallbackURL, popupTimers } from "./callback.ts";
import type { PopupEvent, PopupTimers, MessagePeer } from "./callback.ts";
import { validateControl } from "../control-contracts/index.ts";
import type { ControlMap } from "../control-contracts/index.ts";
import { BoundaryError } from "../contracts/error.ts";

export interface PopupPort extends MessagePeer {
  readonly closed: boolean;
  navigate(url: string): void;
  close(): void;
}
export interface PopupHost {
  origin: string;
  open(): PopupPort | null;
  listen(fn: (event: PopupEvent) => void): () => void;
  onHide(fn: () => void): () => void;
}
type FlowState =
  | "idle"
  | "opening"
  | "waiting"
  | "exchanging"
  | "blocked"
  | "closed"
  | "timed-out"
  | "failed"
  | "cleanup-failed"
  | "disposed";
const flowText: Record<FlowState, string> = {
  idle: "ログインしていません。",
  opening: "認証画面を開いています。",
  waiting: "認証画面での操作を待っています。",
  exchanging: "認可結果を確認しています。",
  blocked: "認証画面を開けません。popupの許可を確認してください。",
  closed: "認証画面が閉じられました。もう一度ログインしてください。",
  "timed-out": "ログインの待機時間を過ぎました。もう一度開始してください。",
  failed: "ログインを完了できませんでした。もう一度開始してください。",
  "cleanup-failed":
    "認証画面を閉じられません。手動で閉じてから再ログインしてください。",
  disposed: "認証の画面を終了しました。",
};
type Attempt = {
  port: PopupPort;
  state: string | undefined;
  received: boolean;
  off: (() => void)[];
  resolve(): void;
  reject(error: BoundaryError): void;
};

export class PopupLogin {
  #client: BrowserSession;
  #host: PopupHost;
  #origin: string;
  #redirectUri: string;
  #timers: PopupTimers;
  #status: FlowState = "idle";
  #active: Attempt | undefined;
  #disposed = false;
  #hide: () => void;
  #closing = new Map<PopupPort, () => void>();

  // 実windowのoriginと公開構成を一致させる。別originの構成をそのまま流用しない。
  constructor(
    config: ControlMap["OidcPublicConfig"],
    host: PopupHost,
    runtime: {
      fetch?: typeof fetch;
      now?: () => number;
      timers?: PopupTimers;
    } = {},
  ) {
    this.#client = new BrowserSession(config, runtime);
    if (host.origin !== config.appOrigin)
      throw new BoundaryError(
        "WRONG_APP_ORIGIN",
        "この画面のログイン設定を確認してください。",
        403,
      );
    this.#host = host;
    this.#origin = config.appOrigin;
    this.#redirectUri = config.redirectUri;
    this.#timers = runtime.timers ?? popupTimers;
    this.#hide = host.onHide(() => this.dispose());
  }
  get snapshot(): Readonly<{
    state: string;
    message: string;
    expiresAt: number | null;
  }> {
    const session = this.#client.snapshot;
    return this.#status === "idle"
      ? session
      : Object.freeze({
          state: this.#status,
          message: flowText[this.#status],
          expiresAt: session.expiresAt,
        });
  }
  #close(port: PopupPort): void {
    try {
      if (!port.closed) port.close();
    } catch {
      this.#status = "cleanup-failed";
    }
  }
  #finish(attempt: Attempt, status: FlowState): void {
    if (this.#active !== attempt) return;
    this.#active = undefined;
    for (const off of attempt.off) off();
    this.#status = status;
    if (status === "idle") {
      // callback自身がACKで閉じる猶予を設け、届かない場合も500ms後に親が回収する。
      const off = this.#timers.after(500, () => {
        this.#closing.delete(attempt.port);
        this.#close(attempt.port);
      });
      this.#closing.set(attempt.port, off);
      attempt.resolve();
    } else {
      this.#client.cancel();
      this.#close(attempt.port);
      attempt.reject(
        new BoundaryError("POPUP_FAILED", flowText[this.#status], 401),
      );
    }
  }
  #receive(attempt: Attempt, event: PopupEvent): void {
    if (
      this.#active !== attempt ||
      attempt.received ||
      !attempt.state ||
      event.origin !== this.#origin ||
      event.source !== attempt.port.source
    )
      return;
    try {
      const message = validateControl("BrowserCallbackMessage", event.data);
      const fields = parseCallbackURL(message.url, this.#redirectUri);
      if (fields.state !== attempt.state)
        throw new Error("開始状態が一致しません。");
      attempt.received = true;
      this.#status = "exchanging";
      void this.#client.complete(message.url).then(
        () => {
          if (this.#active !== attempt) return;
          try {
            attempt.port.post(
              validateControl("BrowserCallbackAck", {
                type: "telestra.auth.complete.v1",
                state: attempt.state,
                outcome: "success",
              }),
              this.#origin,
            );
            this.#finish(attempt, "idle");
          } catch {
            this.#finish(attempt, "failed");
          }
        },
        () => this.#finish(attempt, "failed"),
      );
    } catch {
      this.#finish(attempt, "failed");
    }
  }

  // clickの同期区間でabout:blankを一つ開く。cryptoのawait後にwindow.openしない。
  login(): Promise<void> {
    if (
      this.#disposed ||
      this.#active ||
      this.#client.snapshot.expiresAt !== null
    )
      return Promise.reject(
        new BoundaryError(
          "LOGIN_BUSY",
          "進行中の操作を完了するか、先にログアウトしてください。",
          409,
        ),
      );
    let port: PopupPort | null;
    try {
      port = this.#host.open();
    } catch {
      port = null;
    }
    if (!port) {
      this.#status = "blocked";
      return Promise.reject(
        new BoundaryError("POPUP_BLOCKED", flowText.blocked, 409),
      );
    }
    this.#status = "opening";
    return new Promise<void>((resolve, reject) => {
      const attempt: Attempt = {
        port,
        state: undefined,
        received: false,
        off: [],
        resolve,
        reject,
      };
      this.#active = attempt;
      try {
        // 登録できた順に回収手段を保持し、次の設定が失敗しても既存listenerを残さない。
        attempt.off.push(
          this.#host.listen((event) => this.#receive(attempt, event)),
        );
        attempt.off.push(
          this.#timers.after(120_000, () => this.#finish(attempt, "timed-out")),
        );
        attempt.off.push(
          this.#timers.every(250, () => {
            try {
              if (port.closed) this.#finish(attempt, "closed");
            } catch {
              this.#finish(attempt, "failed");
            }
          }),
        );
      } catch {
        this.#finish(attempt, "failed");
        return;
      }
      void this.#client.begin().then(
        (url) => {
          if (this.#active !== attempt) return;
          try {
            attempt.state = new URL(url).searchParams.get("state") ?? undefined;
            this.#status = "waiting";
            port.navigate(url);
          } catch {
            this.#finish(attempt, "failed");
          }
        },
        () => this.#finish(attempt, "failed"),
      );
    });
  }
  // 中断はローカルの破棄であり、IdP全体や既発行資格の失効成功とは表示しない。
  cancel(): void {
    if (this.#active) this.#finish(this.#active, "closed");
  }
  // 利用者情報は現在のAPIセッションから取得し、popupの申告値を使わない。
  session() {
    return this.#client.session();
  }
  // 認証済みの限定API操作は、BrowserSessionの送信先・サイズ・認可処理へ渡す。
  request(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ) {
    return this.#client.request(path, options);
  }
  // 接続中の認可だけを先に止め、確定済み資格の失効はBrowserSessionに任せる。
  async logout(): Promise<void> {
    this.cancel();
    this.#status = "idle";
    await this.#client.logout();
  }
  // pagehideと明示破棄の両方でlistener・timer・popupを回収し、再利用を拒否する。
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
    this.#hide();
    for (const [port, off] of this.#closing) {
      off();
      this.#close(port);
    }
    this.#closing.clear();
    this.#client.cancel();
    this.#status = "disposed";
  }
}
