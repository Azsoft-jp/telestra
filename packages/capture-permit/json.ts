// v2署名対象のJSONを厳密に解析する。重複キー、非整数表記、不正UTF-8、過大な深さを拒否する。
export function strictJson(raw: Uint8Array, limit: number): unknown {
  if (raw.byteLength === 0 || raw.byteLength > limit)
    throw new Error("JSONを確認してください。");
  const source = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(raw);
  let offset = 0;
  const stringPattern =
    /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y;
  const numberPattern = /-?(?:0|[1-9][0-9]*)/y;
  const fail = (): never => {
    throw new Error("JSONを確認してください。");
  };
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(source[offset] ?? "!")) offset++;
  };
  const text = (): string => {
    stringPattern.lastIndex = offset;
    const match = stringPattern.exec(source);
    if (!match) return fail();
    offset = stringPattern.lastIndex;
    const value = JSON.parse(match[0]) as string;
    if (/[\uD800-\uDFFF]/u.test(value)) return fail();
    return value;
  };
  const value = (depth: number): unknown => {
    if (depth > 32) return fail();
    whitespace();
    if (source[offset] === '"') return text();
    if (source[offset] === "{") {
      offset++;
      const result = Object.create(null) as Record<string, unknown>;
      const names = new Set<string>();
      whitespace();
      if (source[offset] !== "}") {
        for (;;) {
          whitespace();
          const name = text();
          if (names.has(name)) return fail();
          names.add(name);
          whitespace();
          if (source[offset++] !== ":") return fail();
          result[name] = value(depth + 1);
          whitespace();
          if (source[offset] !== ",") break;
          offset++;
        }
      }
      if (source[offset++] !== "}") return fail();
      return result;
    }
    if (source[offset] === "[") {
      offset++;
      const result: unknown[] = [];
      whitespace();
      if (source[offset] !== "]") {
        for (;;) {
          result.push(value(depth + 1));
          whitespace();
          if (source[offset] !== ",") break;
          offset++;
        }
      }
      if (source[offset++] !== "]") return fail();
      return result;
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    }
    numberPattern.lastIndex = offset;
    const number = numberPattern.exec(source);
    if (!number) return fail();
    offset = numberPattern.lastIndex;
    const parsed = Number(number[0]);
    if (!Number.isSafeInteger(parsed)) return fail();
    return parsed;
  };
  const result = value(0);
  whitespace();
  if (offset !== source.length) return fail();
  return result;
}
