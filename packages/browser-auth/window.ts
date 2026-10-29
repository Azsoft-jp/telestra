// 実ブラウザのWindowProxyを同一性として扱い、認可結果を別windowへ取り違えない。
import type { PopupHost } from "./popup.ts";
import type { CallbackHost, PopupEvent } from "./callback.ts";

function listeners(window: Window) {
  return {
    listen(fn: (event: PopupEvent) => void) {
      const listener = (event: MessageEvent<unknown>) =>
        fn({ origin: event.origin, source: event.source, data: event.data });
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
    onHide(fn: () => void) {
      window.addEventListener("pagehide", fn);
      return () => window.removeEventListener("pagehide", fn);
    },
  };
}
// 開いたWindowProxyをそのままsourceとして保持し、後からwindow名で探索しない。
export function browserPopupHost(window: Window): PopupHost {
  return {
    origin: window.location.origin,
    ...listeners(window),
    open: () => {
      const popup = window.open(
        "about:blank",
        "_blank",
        "popup,width=520,height=700",
      );
      if (!popup) return null;
      return {
        source: popup,
        get closed() {
          return popup.closed;
        },
        navigate: (url) => popup.location.replace(url),
        post: (data, origin) => popup.postMessage(data, origin),
        close: () => popup.close(),
      };
    },
  };
}
// URLの秘密値はhistoryから除去し、openerには固定originのpostMessage以外を行わない。
export function browserCallbackHost(window: Window): CallbackHost {
  const opener: Window | null = window.opener as Window | null;
  return {
    origin: window.location.origin,
    url: window.location.href,
    ...listeners(window),
    opener: opener
      ? {
          source: opener,
          post: (data, origin) => opener.postMessage(data, origin),
        }
      : null,
    scrub: (uri) => window.history.replaceState(null, "", uri),
    close: () => window.close(),
  };
}
