// 制御APIのJSON本文を有限の時間・実読取量で検証する。資格や入力値は例外へ含めない。
import { BoundaryError } from "../../packages/contracts/error.ts";
import { parseJson } from "../../packages/identity/index.ts";

export const bodyLimits = Object.freeze({
  bytes: 8192,
  milliseconds: 5000,
  reads: 16_384,
});

// 時計は試験で差し替える内部依存であり、HTTP入力から上限を変更する入口ではない。
export interface BodyClock {
  now(): number;
  after(milliseconds: number, fn: () => void): () => void;
}
interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<unknown>;
  releaseLock(): void;
}
interface BodyInput {
  headers: { get(name: string): string | null };
  body: {
    getReader(): BodyReader;
    cancel(): Promise<unknown>;
  } | null;
  signal?: {
    readonly aborted: boolean;
    addEventListener(
      type: "abort",
      fn: () => void,
      options: { once: true },
    ): void;
    removeEventListener(type: "abort", fn: () => void): void;
  };
}

const systemClock: BodyClock = {
  now: () => performance.now(),
  after: (milliseconds, fn) => {
    const timer = setTimeout(fn, milliseconds);
    return () => clearTimeout(timer);
  },
};
function invalid(): BoundaryError {
  return new BoundaryError(
    "INVALID_JSON",
    "データの文字形式を確認してください。",
  );
}
function timedOut(): BoundaryError {
  return new BoundaryError(
    "BODY_TIMEOUT",
    "データの受信時間を過ぎました。",
    408,
  );
}
function aborted(): BoundaryError {
  return new BoundaryError("BODY_ABORTED", "データの受信が中断されました。");
}

// WorkerとDOは同じ上限を使い、本文の途中停止で接続管理を待たせ続けない。
// cancelの完了は待たず、上流の回収処理が止まっても期限超過を呼出元へ返す。
export async function readJsonBody(
  input: BodyInput,
  clock: BodyClock = systemClock,
): Promise<unknown> {
  let reader: BodyReader | undefined;
  let eof = false;
  let succeeded = false;
  let cancelTimer = () => {};
  let offAbort = () => {};
  let stopped: BoundaryError | undefined;
  try {
    if (
      input.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      throw new BoundaryError(
        "CONTENT_TYPE",
        "JSON形式で送信してください。",
        415,
      );
    const encoding = input.headers
      .get("Content-Encoding")
      ?.trim()
      .toLowerCase();
    if (encoding && encoding !== "identity")
      throw new BoundaryError(
        "CONTENT_ENCODING",
        "圧縮していないJSONを送信してください。",
        415,
      );
    const declared = input.headers.get("Content-Length");
    if (declared !== null && !/^\d+$/.test(declared))
      throw new BoundaryError(
        "INVALID_LENGTH",
        "データの長さを確認してください。",
      );
    if (declared !== null && Number(declared) > bodyLimits.bytes)
      throw new BoundaryError("TOO_LARGE", "データが上限を超えています。", 413);
    if (!input.body)
      throw new BoundaryError("INVALID_JSON", "データがありません。");
    if (input.signal?.aborted) throw aborted();

    const deadline = clock.now() + bodyLimits.milliseconds;
    if (!Number.isFinite(deadline)) throw invalid();
    reader = input.body.getReader();
    const current = reader;
    let rejectStop: (error: BoundaryError) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
    });
    const stop = (error: BoundaryError) => {
      if (stopped) return;
      stopped = error;
      rejectStop(error);
    };
    const onAbort = () => stop(aborted());
    input.signal?.addEventListener("abort", onAbort, { once: true });
    offAbort = () => input.signal?.removeEventListener("abort", onAbort);
    cancelTimer = clock.after(bodyLimits.milliseconds, () => stop(timedOut()));
    const check = () => {
      if (stopped) throw stopped;
      if (input.signal?.aborted) throw aborted();
      const now = clock.now();
      if (!Number.isFinite(now) || now >= deadline) throw timedOut();
    };
    const consume = async () => {
      let raw = "",
        bytes = 0,
        reads = 0;
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      });
      for (;;) {
        check();
        // 空chunkがmicrotaskで届き続けても、timerの発火前に有限回で止める。
        if (++reads > bodyLimits.reads)
          throw new BoundaryError(
            "TOO_MANY_PARTS",
            "データの分割数が上限を超えています。",
            413,
          );
        const part = await current.read();
        check();
        if (part.done) {
          eof = true;
          break;
        }
        if (!(part.value instanceof Uint8Array)) throw invalid();
        bytes += part.value.byteLength;
        if (bytes > bodyLimits.bytes)
          throw new BoundaryError(
            "TOO_LARGE",
            "データが上限を超えています。",
            413,
          );
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
      if (declared !== null && bytes !== Number(declared))
        throw new BoundaryError(
          "INVALID_LENGTH",
          "データの長さを確認してください。",
        );
      check();
      return parseJson(raw, bodyLimits.bytes);
    };
    const value = await Promise.race([consume(), interrupted]);
    succeeded = true;
    return value;
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw invalid();
  } finally {
    cancelTimer();
    offAbort();
    // 未完の入力へcancelを一度要求する。失敗の本文をログへ出さず、失敗応答の期限を延ばさない。
    if (!eof) {
      try {
        void (reader ?? input.body)?.cancel().catch(() => {});
      } catch {
        /* 入力の拒否は維持し、回収失敗で待機を延ばさない。 */
      }
    }
    try {
      reader?.releaseLock();
    } catch {
      // 正常な読み取りで解放できなければ成功を返さない。既に拒否した入力の理由は維持する。
      if (succeeded)
        throw new BoundaryError(
          "BODY_UNAVAILABLE",
          "データの読み取りを完了できません。",
          503,
        );
    }
  }
}
