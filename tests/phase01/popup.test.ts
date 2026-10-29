// windowの同一性を持つfixtureで認可結果を返し、実際のローカルAPIまで接続する。
import assert from "node:assert/strict";
import { fixture, origin } from "./helper.ts";
import { mockOidc } from "./mock-oidc.ts";
import { PopupLogin } from "../../packages/browser-auth/popup.ts";
import { scenario } from "../evidence.ts";
import { relayCallback } from "../../packages/browser-auth/callback.ts";
import type {
  PopupEvent,
  PopupTimers,
  CallbackHost,
} from "../../packages/browser-auth/callback.ts";
import type {
  PopupHost,
  PopupPort,
} from "../../packages/browser-auth/popup.ts";

// 実時間を待たずに期限とlistener回収を検証する。URL・コード・資格は診断出力へ渡さない。
function fakeWindow() {
  const messages = new Set<(event: PopupEvent) => void>(),
    hides = new Set<() => void>();
  const tasks = new Set<{ ms: number; fn: () => void; repeat: boolean }>();
  const schedule = (ms: number, fn: () => void, repeat: boolean) => {
    const task = { ms, fn, repeat };
    tasks.add(task);
    return () => {
      tasks.delete(task);
    };
  };
  const timers: PopupTimers = {
    after: (ms, fn) => schedule(ms, fn, false),
    every: (ms, fn) => schedule(ms, fn, true),
  };
  const frames: {
    port: PopupPort;
    ready: Promise<string>;
    setClosed(): void;
  }[] = [];
  let blocked = false;
  const host: PopupHost = {
    origin,
    open: () => {
      if (blocked) return null;
      let navigate: (url: string) => void = () => {},
        closed = false;
      const ready = new Promise<string>((resolve) => {
        navigate = resolve;
      });
      const port: PopupPort = {
        source: {},
        get closed() {
          return closed;
        },
        navigate,
        close: () => {
          closed = true;
        },
        post: () => {},
      };
      frames.push({
        port,
        ready,
        setClosed: () => {
          closed = true;
        },
      });
      return port;
    },
    listen: (fn) => {
      messages.add(fn);
      return () => {
        messages.delete(fn);
      };
    },
    onHide: (fn) => {
      hides.add(fn);
      return () => {
        hides.delete(fn);
      };
    },
  };
  return {
    host,
    timers,
    frames,
    messages,
    hides,
    tasks,
    block: () => {
      blocked = true;
    },
    send: (event: PopupEvent) => {
      for (const fn of [...messages]) fn(event);
    },
    tick: (ms: number) => {
      for (const task of [...tasks])
        if (task.ms === ms) {
          if (!task.repeat) tasks.delete(task);
          task.fn();
        }
    },
  };
}

scenario(
  "SEC-04",
  "popup-callback-to-api-session",
  "memory-window-source-pkce-v1",
  "操作内でpopupを一つ開き、同じoriginとwindowの認可結果だけを照合してAPIセッションを確定する",
  async () => {
    const context = await fixture();
    let flow: PopupLogin | undefined;
    try {
      const provider = mockOidc(context),
        source = {};
      let opened = 0;
      let receive:
        | ((event: { origin: string; source: unknown; data: unknown }) => void)
        | undefined;
      const popup = {
        source,
        closed: false,
        navigate: (url: string) =>
          receive?.({
            origin,
            source,
            data: {
              type: "telestra.auth.callback.v1",
              url: provider.authorize(url),
            },
          }),
        post: (_data: unknown, target: string) => {
          assert.equal(target, origin);
          popup.closed = true;
        },
        close: () => {
          popup.closed = true;
        },
      };
      const host = {
        origin,
        open: () => {
          opened++;
          return popup;
        },
        listen: (fn: typeof receive) => {
          receive = fn;
          return () => {
            receive = undefined;
          };
        },
        onHide: () => () => {},
      };
      flow = new PopupLogin(provider.config, host, { fetch: provider.fetch });
      const done = flow.login();
      assert.equal(opened, 1, "非同期処理より前にpopupを開きませんでした。");
      await done;
      assert.equal(flow.snapshot.state, "authenticated");
      assert.equal(provider.tokenRequests, 1);
      assert.equal(provider.apiRequests, 1);
      assert.equal(context.egress, 0);
    } finally {
      flow?.dispose?.();
      await context.close();
    }
  },
);

scenario(
  "SEC-04",
  "popup-origin-source-schema-and-replay",
  "window-origin-source-denials-v1",
  "別origin・別windowを処理せず、正しいwindowでもSchema違反を拒否し、認可結果を再利用しない",
  async () => {
    const context = await fixture();
    try {
      const provider = mockOidc(context),
        mock = fakeWindow();
      const flow = new PopupLogin(provider.config, mock.host, {
        fetch: provider.fetch,
        timers: mock.timers,
      });
      try {
        const done = flow.login(),
          frame = mock.frames[0]!;
        const callback = provider.authorize(await frame.ready);
        const data = { type: "telestra.auth.callback.v1", url: callback };
        mock.send({
          origin: "https://other.example.test",
          source: frame.port.source,
          data,
        });
        mock.send({ origin, source: {}, data });
        assert.equal(provider.tokenRequests, 0);
        assert.equal(flow.snapshot.state, "waiting");
        mock.send({ origin, source: frame.port.source, data });
        await done;
        mock.send({ origin, source: frame.port.source, data });
        assert.equal(provider.tokenRequests, 1);
        assert.equal(mock.messages.size, 0);
      } finally {
        flow.dispose();
      }
      for (const bad of [
        { type: "unknown", url: "https://example.invalid" },
        { type: "telestra.auth.callback.v1", url: "x".repeat(4097) },
        {
          type: "telestra.auth.callback.v1",
          url: "https://example.invalid",
          shell: "not allowed",
        },
      ]) {
        const window = fakeWindow(),
          current = new PopupLogin(provider.config, window.host, {
            fetch: provider.fetch,
            timers: window.timers,
          });
        try {
          const rejected = assert.rejects(current.login());
          const frame = window.frames[0]!;
          await frame.ready;
          window.send({ origin, source: frame.port.source, data: bad });
          await rejected;
          assert.equal(current.snapshot.state, "failed");
          assert.equal(frame.port.closed, true);
          assert.equal(window.messages.size, 0);
          assert.equal(window.tasks.size, 0);
        } finally {
          current.dispose();
        }
      }
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "CORE-02",
  "popup-block-close-timeout-and-dispose",
  "bounded-window-lifecycle-v1",
  "popup拒否・同時開始・手動終了・期限・破棄を区別し、windowとlistener・timerを回収する",
  async () => {
    const context = await fixture();
    try {
      for (const outcome of [
        "block",
        "close",
        "timeout",
        "cancel",
        "dispose",
      ] as const) {
        const mock = fakeWindow(),
          provider = mockOidc(context);
        const flow = new PopupLogin(provider.config, mock.host, {
          fetch: provider.fetch,
          timers: mock.timers,
        });
        try {
          if (outcome === "block") mock.block();
          const rejected = assert.rejects(flow.login());
          if (outcome !== "block") {
            await mock.frames[0]!.ready;
            await assert.rejects(flow.login(), { code: "LOGIN_BUSY" });
            assert.equal(mock.frames.length, 1);
            if (outcome === "close") {
              mock.frames[0]!.setClosed();
              mock.tick(250);
            }
            if (outcome === "timeout") mock.tick(120_000);
            if (outcome === "cancel") flow.cancel();
            if (outcome === "dispose") flow.dispose();
          }
          await rejected;
          assert.equal(provider.tokenRequests, 0);
          assert.equal(
            flow.snapshot.state,
            outcome === "block"
              ? "blocked"
              : outcome === "timeout"
                ? "timed-out"
                : outcome === "dispose"
                  ? "disposed"
                  : "closed",
          );
          assert.equal(mock.messages.size, 0);
          assert.equal(mock.tasks.size, 0);
        } finally {
          flow.dispose();
        }
        assert.equal(mock.hides.size, 0);
        await assert.rejects(flow.login());
      }
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-04",
  "callback-scrub-and-bound-ack",
  "scrub-before-post-window-ack-v1",
  "認可URLを消して一度だけ送信し、別origin・別window・別stateのACKを無視して閉じる",
  async () => {
    const mock = fakeWindow(),
      parent = {},
      state = "A".repeat(43);
    let scrubbed = false,
      posts = 0,
      closes = 0;
    const host: CallbackHost = {
      origin,
      url: `${origin}/auth/callback?code=synthetic&state=${state}&iss=https%3A%2F%2Fidp.example.test`,
      opener: {
        source: parent,
        post: (_data, target) => {
          assert.equal(scrubbed, true);
          assert.equal(target, origin);
          posts++;
        },
      },
      scrub: (uri) => {
        assert.equal(uri, origin + "/auth/callback");
        scrubbed = true;
      },
      // pagehideが同期に起きても、検証済みACKを失敗へ読み替えないことを確認する。
      close: () => {
        closes++;
        for (const fn of [...mock.hides]) fn();
      },
      listen: mock.host.listen,
      onHide: mock.host.onHide,
    };
    const result = relayCallback(host, origin + "/auth/callback", mock.timers);
    const ack = {
      type: "telestra.auth.complete.v1",
      state,
      outcome: "success",
    };
    mock.send({
      origin: "https://other.example.test",
      source: parent,
      data: ack,
    });
    mock.send({ origin, source: {}, data: ack });
    mock.send({
      origin,
      source: parent,
      data: { ...ack, state: "B".repeat(43) },
    });
    assert.equal(mock.tasks.size, 1);
    mock.send({ origin, source: parent, data: ack });
    assert.equal(await result, "success");
    assert.equal(posts, 1);
    assert.equal(closes, 1);
    assert.equal(mock.messages.size + mock.hides.size + mock.tasks.size, 0);
  },
);

scenario(
  "CORE-02",
  "popup-partial-setup-is-recovered",
  "window-listener-timer-failure-v1",
  "listener・timerの設定途中で失敗してもwindowを回収し、途中で登録したlistenerを残さない",
  async () => {
    const context = await fixture();
    try {
      for (const at of ["listener", "timer"]) {
        const provider = mockOidc(context),
          mock = fakeWindow();
        const host =
          at === "listener"
            ? {
                ...mock.host,
                listen: () => {
                  throw new Error("合成した設定失敗です。");
                },
              }
            : mock.host;
        const timers =
          at === "timer"
            ? {
                ...mock.timers,
                after: () => {
                  throw new Error("合成した設定失敗です。");
                },
              }
            : mock.timers;
        const flow = new PopupLogin(provider.config, host, {
          fetch: provider.fetch,
          timers,
        });
        try {
          await assert.rejects(flow.login());
          assert.equal(flow.snapshot.state, "failed");
          assert.equal(mock.frames[0]!.port.closed, true);
          assert.equal(mock.messages.size + mock.tasks.size, 0);
        } finally {
          flow.dispose();
        }
      }
    } finally {
      await context.close();
    }
  },
);
