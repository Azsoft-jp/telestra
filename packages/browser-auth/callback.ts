// 認可結果の固定URLを検証し、callbackのアドレスを消してから元windowへ一度だけ返す。
import { validateControl } from "../control-contracts/index.ts";
import { BoundaryError } from "../contracts/error.ts";

export function parseCallbackURL(raw: string, redirectUri: string) {
  if (
    typeof raw !== "string" ||
    new TextEncoder().encode(raw).byteLength > 4096
  )
    throw new BoundaryError(
      "INVALID_CALLBACK",
      "認可結果を確認できません。",
      400,
    );
  const url = new URL(raw);
  if (
    url.origin + url.pathname !== redirectUri ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new BoundaryError(
      "INVALID_CALLBACK",
      "認可結果を確認できません。",
      400,
    );
  const fields = Object.create(null) as Record<string, string>;
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(fields, key))
      throw new BoundaryError(
        "INVALID_CALLBACK",
        "認可結果を確認できません。",
        400,
      );
    fields[key] = value;
  }
  const input = validateControl("OidcCallback", fields);
  if (!/^[\x21-\x7e]+$/.test(input.code))
    throw new BoundaryError(
      "INVALID_CALLBACK",
      "認可結果を確認できません。",
      400,
    );
  return input;
}

export interface PopupEvent {
  origin: string;
  source: unknown;
  data: unknown;
}
export interface MessagePeer {
  source: unknown;
  post(data: unknown, origin: string): void;
}
export interface PopupTimers {
  after(milliseconds: number, fn: () => void): () => void;
  every(milliseconds: number, fn: () => void): () => void;
}
export const popupTimers: PopupTimers = {
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};
export interface CallbackHost {
  origin: string;
  url: string;
  opener: MessagePeer | null;
  scrub(uri: string): void;
  close(): void;
  listen(fn: (event: PopupEvent) => void): () => void;
  onHide(fn: () => void): () => void;
}

// targetOriginにwildcardを使わず、ACKも元window・origin・開始stateへ拘束する。
export async function relayCallback(
  host: CallbackHost,
  redirectUri: string,
  timers = popupTimers,
): Promise<"success" | "failed"> {
  const raw = host.url;
  try {
    if (new URL(redirectUri).origin !== host.origin) return "failed";
    host.scrub(redirectUri);
    const fields = parseCallbackURL(raw, redirectUri),
      opener = host.opener;
    if (!opener) return "failed";
    return await new Promise<"success" | "failed">((resolve) => {
      let ended = false;
      const cleanup: (() => void)[] = [];
      const finish = (outcome: "success" | "failed") => {
        if (ended) return;
        ended = true;
        for (const off of cleanup) off();
        resolve(outcome);
      };
      try {
        cleanup.push(
          host.listen((event) => {
            if (event.origin !== host.origin || event.source !== opener.source)
              return;
            try {
              const ack = validateControl("BrowserCallbackAck", event.data);
              if (ack.state !== fields.state) return;
              // pagehideより先に検証済みACKを確定し、閉じる際のイベントで失敗へ変えない。
              finish(ack.outcome);
              host.close();
            } catch {
              finish("failed");
            }
          }),
        );
        cleanup.push(host.onHide(() => finish("failed")));
        cleanup.push(timers.after(15_000, () => finish("failed")));
        opener.post(
          validateControl("BrowserCallbackMessage", {
            type: "telestra.auth.callback.v1",
            url: raw,
          }),
          host.origin,
        );
      } catch {
        finish("failed");
      }
    });
  } catch {
    return "failed";
  }
}
