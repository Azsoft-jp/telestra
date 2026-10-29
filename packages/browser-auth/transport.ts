// Cookie・キャッシュ・redirectを使わず、応答全体の時間と実読取量を制限する。
import { BoundaryError } from "../contracts/error.ts";
import { parseJson } from "../identity/index.ts";

export async function readResponse(
  perform: typeof fetch,
  url: string,
  init: RequestInit,
  controller: AbortController,
): Promise<{ status: number; value: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const networkError = () =>
    new BoundaryError(
      "AUTH_NETWORK",
      "接続を確認できません。もう一度操作してください。",
      503,
    );
  const work = async () => {
    const response = await perform(url, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      signal: controller.signal,
    });
    if (
      controller.signal.aborted ||
      (response.status >= 300 && response.status < 400) ||
      response.redirected ||
      response.type === "opaqueredirect"
    ) {
      await response.body?.cancel();
      throw networkError();
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      return { status: response.status, value: undefined };
    }
    if (
      !/^application\/json(?:;|$)/i.test(
        response.headers.get("Content-Type") ?? "",
      ) ||
      !(response.headers.get("Cache-Control") ?? "")
        .toLowerCase()
        .split(",")
        .some((v) => v.trim() === "no-store") ||
      !response.body
    ) {
      await response.body?.cancel();
      throw networkError();
    }
    const size = response.headers.get("Content-Length");
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > 16_384)) {
      await response.body.cancel();
      throw networkError();
    }
    const current = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true });
    reader = current;
    let bytes = 0,
      text = "";
    try {
      for (;;) {
        const part = await current.read();
        if (controller.signal.aborted) throw networkError();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16_384) throw networkError();
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      return { status: response.status, value: parseJson(text) };
    } finally {
      await current.cancel();
      current.releaseLock();
      reader = undefined;
    }
  };
  if (controller.signal.aborted) throw networkError();
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      // 失敗は既に呼出元へ返す。stream回収の失敗で待機を無期限に延ばさない。
      if (reader) void reader.cancel().catch(() => {});
      reject(networkError());
    };
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      work(),
      aborted,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(networkError());
        }, 5000);
      }),
    ]);
  } catch {
    throw networkError();
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
