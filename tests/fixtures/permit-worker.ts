// 実workerdで同じ検証器を動かす試験専用入口。公開APIや録画命令として配備しない。
import { CapturePermitVerifier } from "../../packages/capture-permit/index.ts";
import { strictJson } from "../../packages/capture-permit/json.ts";
import type { ControlMap } from "../../packages/control-contracts/index.ts";
// 試験入口にも1MiB・5秒・読取回数の上限を設け、過大本文を全量確保しない。
export async function readBounded(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new Error("試験本文がありません。");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("試験本文の期限切れです。")),
      5000,
    );
  });
  const parts: Uint8Array[] = [];
  let length = 0,
    complete = false;
  try {
    for (let reads = 0; reads < 16384; reads++) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) {
        complete = true;
        break;
      }
      length += item.value.byteLength;
      if (length > 1_048_576) throw new Error("試験本文が過大です。");
      parts.push(item.value);
    }
    if (!complete) throw new Error("試験本文の読取上限です。");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    if (!complete)
      void reader.cancel().catch(() => {
        /* 試験入力を出力せず、待機も延長しない。 */
      });
    reader.releaseLock();
  }
}
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const bytes = await readBounded(request);
      const input = strictJson(bytes, 1_048_576) as {
        issuer: string;
        keys: unknown[];
        cases: {
          token: string;
          context: ControlMap["CapturePermitV2Context"];
        }[];
      };
      if (
        request.method !== "POST" ||
        !Array.isArray(input.cases) ||
        input.cases.length > 128
      )
        throw new Error("試験入力を確認してください。");
      const verifier = await CapturePermitVerifier.create(
        input.issuer,
        input.keys,
      );
      const results = [];
      for (const item of input.cases) {
        try {
          const verified = await verifier.verify(item.token, item.context);
          results.push(
            verified.executionAuthorized === false
              ? verified.window
              : "rejected",
          );
        } catch {
          results.push("rejected");
        }
      }
      return Response.json({ ok: true, results });
    } catch {
      return Response.json({ ok: false }, { status: 400 });
    }
  },
};
