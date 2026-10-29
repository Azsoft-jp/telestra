// 合成streamと模擬時計で、本文全体の期限・UTF-8・中断・回収要求を確認する。
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readJsonBody, bodyLimits } from "../../apps/control/body.ts";
import type { BodyClock } from "../../apps/control/body.ts";
import { BoundaryError } from "../../packages/contracts/error.ts";
import { scenario } from "../evidence.ts";

class Clock implements BodyClock {
  time = 0;
  pending = new Set<() => void>();
  scheduled = 0;
  now() {
    return this.time;
  }
  after(milliseconds: number, fn: () => void) {
    assert.equal(milliseconds, bodyLimits.milliseconds);
    this.scheduled++;
    this.pending.add(fn);
    return () => this.pending.delete(fn);
  }
  expire() {
    this.time = bodyLimits.milliseconds;
    for (const fn of this.pending) fn();
  }
}
function source(
  chunks: Uint8Array[],
  options: { stalled?: boolean; cancel?: () => void | Promise<void> } = {},
) {
  let cancelled = 0;
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = queue.shift();
        if (chunk) controller.enqueue(chunk);
        else if (!options.stalled) controller.close();
      },
      cancel() {
        cancelled++;
        return options.cancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    get cancelled() {
      return cancelled;
    },
  };
}
function input(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return {
    body,
    headers: new Headers({ "Content-Type": "application/json", ...headers }),
    ...(signal ? { signal } : {}),
  };
}
function rejected(code: string, status: number) {
  return (error: unknown) =>
    error instanceof BoundaryError &&
    error.code === code &&
    error.status === status;
}
const bytes = (value: string) => new TextEncoder().encode(value);

scenario(
  "CORE-02",
  "body-utf8-and-exact-byte-boundary",
  "chunked-japanese-json-v1",
  "分割されたUTF-8と上限ちょうどのJSONを読み、途中の文字を失わずreaderを解放する",
  async () => {
    const encoded = bytes('{"value":"日本語"}');
    const stream = source(Array.from(encoded, (b) => Uint8Array.of(b)));
    const clock = new Clock();
    const abort = new AbortController();
    assert.deepEqual(
      await readJsonBody(input(stream.body, {}, abort.signal), clock),
      {
        value: "日本語",
      },
    );
    assert.equal(stream.body.locked, false);
    assert.equal(clock.pending.size, 0);
    assert.equal(clock.scheduled, 1);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    const exact = bytes('"' + "a".repeat(bodyLimits.bytes - 2) + '"');
    assert.equal(
      ((await readJsonBody(input(source([exact]).body), clock)) as string)
        .length,
      bodyLimits.bytes - 2,
    );
    assert.equal(clock.pending.size, 0);
  },
);

scenario(
  "SEC-10",
  "body-size-format-and-empty-read-limits",
  "bounded-json-denials-v1",
  "宣言と実量、空chunkの過多、非JSON・圧縮・不正UTF-8を拒否し、入力値を例外へ出さない",
  async () => {
    for (const [chunks, headers, code, status] of [
      [[bytes("{}")], { "Content-Length": "8193" }, "TOO_LARGE", 413],
      [[bytes("{}")], { "Content-Length": "oops" }, "INVALID_LENGTH", 400],
      [[bytes("{}")], { "Content-Length": "3" }, "INVALID_LENGTH", 400],
      [[bytes("{}")], { "Content-Type": "text/plain" }, "CONTENT_TYPE", 415],
      [[bytes("{}")], { "Content-Encoding": "gzip" }, "CONTENT_ENCODING", 415],
      [
        [bytes('"'), bytes("あ".repeat(3000)), bytes('"')],
        {},
        "TOO_LARGE",
        413,
      ],
      [[Uint8Array.of(0xff)], {}, "INVALID_JSON", 400],
      [[bytes('"'), Uint8Array.of(0xe3, 0x81)], {}, "INVALID_JSON", 400],
      [[bytes("synthetic-secret-marker")], {}, "INVALID_JSON", 400],
    ] as const) {
      // EOFが必要な拒否だけは閉じたstreamを使う。
      const selected = source([...chunks], {
        stalled: !(
          ["INVALID_LENGTH", "INVALID_JSON"].includes(code) &&
          new Headers(headers).get("Content-Length") !== "oops"
        ),
      });
      const clock = new Clock();
      await assert.rejects(
        readJsonBody(input(selected.body, headers), clock),
        rejected(code, status),
      );
      assert.equal(selected.body.locked, false);
      assert.equal(clock.pending.size, 0);
    }
    const zeros = source(
      Array.from({ length: bodyLimits.reads + 1 }, () => new Uint8Array()),
    );
    await assert.rejects(
      readJsonBody(input(zeros.body), new Clock()),
      rejected("TOO_MANY_PARTS", 413),
    );
    assert.equal(zeros.cancelled, 1);
    assert.equal(zeros.body.locked, false);
  },
);

scenario(
  "CORE-02",
  "body-read-and-cleanup-failure-denials",
  "broken-stream-reader-v1",
  "sourceの例外を秘匿し、失敗したcancelを待たず、正常時のreader解放失敗を成功にしない",
  async () => {
    const failed = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("synthetic-private-marker"));
      },
    });
    const clock = new Clock();
    const abort = new AbortController();
    await assert.rejects(
      readJsonBody(input(failed, {}, abort.signal), clock),
      (error: unknown) =>
        rejected("INVALID_JSON", 400)(error) &&
        error instanceof Error &&
        !error.message.includes("synthetic-private-marker"),
    );
    assert.equal(failed.locked, false);
    assert.equal(clock.pending.size, 0);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    const cancel = source([new Uint8Array(bodyLimits.bytes + 1)], {
      stalled: true,
      cancel: () => Promise.reject(new Error("synthetic-private-marker")),
    });
    await assert.rejects(
      readJsonBody(input(cancel.body), clock),
      rejected("TOO_LARGE", 413),
    );
    assert.equal(cancel.cancelled, 1);
    assert.equal(cancel.body.locked, false);
    let reads = 0;
    const broken = {
      headers: new Headers({ "Content-Type": "application/json" }),
      body: {
        getReader: () => ({
          read: async () =>
            ++reads === 1
              ? { done: false, value: bytes("{}") }
              : { done: true },
          cancel: async () => {},
          releaseLock: () => {
            throw new Error("synthetic-private-marker");
          },
        }),
        cancel: async () => {},
      },
    };
    await assert.rejects(
      readJsonBody(broken, clock),
      rejected("BODY_UNAVAILABLE", 503),
    );
    assert.equal(clock.pending.size, 0);
  },
);

scenario(
  "SEC-10",
  "body-total-deadline-and-unfinished-cancel",
  "stalled-body-cancel-v1",
  "途中停止を5秒全体の期限で拒否し、中断処理が終わらなくてもAPIの失敗応答を待たせ続けない",
  async () => {
    const stream = source([bytes('{"value":')], {
      stalled: true,
      cancel: () => new Promise(() => {}),
    });
    const clock = new Clock();
    const result = assert.rejects(
      readJsonBody(input(stream.body), clock),
      rejected("BODY_TIMEOUT", 408),
    );
    // 保留中のreadを経てから期限へ進めても、chunkごとに期限を延長しない。
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.expire();
    await result;
    assert.equal(stream.cancelled, 1);
    assert.equal(stream.body.locked, false);
    assert.equal(clock.pending.size, 0);
  },
);

scenario(
  "CORE-02",
  "body-abort-and-late-input-denial",
  "cancelled-json-stream-v1",
  "開始前・途中の中断とdeadline後の完了を拒否し、残ったlistenerとtimerを解放する",
  async () => {
    for (const before of [true, false]) {
      const abort = new AbortController();
      const stream = source([bytes("{")], { stalled: true });
      const clock = new Clock();
      if (before) abort.abort();
      const result = assert.rejects(
        readJsonBody(input(stream.body, {}, abort.signal), clock),
        rejected("BODY_ABORTED", 400),
      );
      if (!before) abort.abort();
      await result;
      assert.equal(stream.cancelled, 1);
      assert.equal(stream.body.locked, false);
      assert.equal(clock.pending.size, 0);
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    }
    const clock = new Clock();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          clock.time = bodyLimits.milliseconds;
          controller.enqueue(bytes("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(
      readJsonBody(input(body), clock),
      rejected("BODY_TIMEOUT", 408),
    );
    assert.equal(body.locked, false);
    assert.equal(clock.pending.size, 0);
  },
);
