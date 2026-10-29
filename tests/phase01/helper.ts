// 実際のworkerdとD1を一時領域で動かし、試験専用の署名鍵はメモリ内だけで保持する。
import { Miniflare, Log, LogLevel } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT, decodeJwt } from "jose";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../../packages/identity/index.ts";

export const origin = "https://tv.example.test";
export const tenantId = "demo-household";

// テスト用の公開鍵だけを登録し、秘密鍵の値をassertionやログへ渡さない。
export async function device(nodeId: string) {
  const keys = await generateKeyPair("EdDSA", { extractable: true });
  const publicJwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: `key-${nodeId}`,
  };
  return { nodeId, publicJwk, privateKey: keys.privateKey };
}
export type Device = Awaited<ReturnType<typeof device>>;

// 外向き通信を拒否したWorkerと専用D1を作り、本番のIdPや資格を使わずに検証する。
export async function fixture(
  tls?: { certificate: string; key: string },
  browserOrigins: readonly string[] = [origin],
) {
  const directory = await mkdtemp(join(tmpdir(), "tv-phase01-"));
  const oidc = await device("oidc-local");
  const signer = await device("control-local");
  const bindings = {
    TELESTRA_ENVIRONMENT: "development",
    TELESTRA_TENANT_ID: tenantId,
    TELESTRA_ALLOWED_ORIGINS: JSON.stringify(browserOrigins),
    TELESTRA_OIDC_ISSUER: "https://idp.example.test",
    TELESTRA_OIDC_AUDIENCE: "tv-api",
    TELESTRA_OIDC_JWKS: JSON.stringify({ keys: [oidc.publicJwk] }),
    TELESTRA_CONTROL_ISSUER: "https://control.example.test",
    TELESTRA_CONTROL_PUBLIC_JWKS: JSON.stringify({ keys: [signer.publicJwk] }),
    TELESTRA_CONTROL_PRIVATE_JWK: JSON.stringify({
      ...(await exportJWK(signer.privateKey)),
      kid: signer.publicJwk.kid,
    }),
  };
  let egress = 0;
  const options = {
    // Request.cf補完による依存ツール自身の外部取得も止め、合成値だけを使う。
    cf: false,
    host: "127.0.0.1",
    port: 0,
    // WSS相互試験だけが、メモリ内で作った試験証明書を使用する。
    ...(tls
      ? { https: true, httpsCert: tls.certificate, httpsKey: tls.key }
      : {}),
    modules: true,
    scriptPath: "artifacts/control/worker.mjs",
    compatibilityDate: "2026-07-30",
    bindings,
    d1Databases: { TELESTRA_DB: "phase01-local" },
    d1Persist: join(directory, "d1"),
    durableObjects: {
      TELESTRA_REGISTRY: { className: "NodeRegistry", useSQLite: true },
    },
    durableObjectsPersist: join(directory, "do"),
    log: new Log(LogLevel.ERROR),
    outboundService: () => {
      egress++;
      return new Response("Network disabled", { status: 403 });
    },
  } as const;
  let mf = new Miniflare(options);
  let database = await mf.getD1Database("TELESTRA_DB");
  // 固定した移行ファイルだけを適用する。入力からSQLやファイル名を組み立てない。
  const sql = await readFile(
    "apps/control/migrations/0001-identity.sql",
    "utf8",
  );
  const statements = sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  await database.batch(
    statements.map((statement) => database.prepare(statement)),
  );
  for (const [subject, role] of [
    ["operator-local", "operator"],
    ["recorder-local", "recorder"],
    ["viewer-local", "viewer"],
    ["other-local", "viewer"],
  ])
    await database
      .prepare(
        "INSERT INTO memberships(environment,tenant_id,subject,role,status) VALUES('development',?,?,?,'active')",
      )
      .bind(tenantId, subject, role)
      .run();
  // 録画のfixtureは合成した台帳情報だけで、実録画や再生可能な媒体を含まない。
  await database
    .prepare(
      "INSERT INTO recordings(environment,tenant_id,recording_id,owner_id,payload) VALUES('development',?,'rec-owned-01','recorder-local',?)",
    )
    .bind(
      tenantId,
      JSON.stringify({
        recordingId: "rec-owned-01",
        state: "partial",
        attemptIds: ["attempt-local-01"],
      }),
    )
    .run();
  const now = () => Math.floor(Date.now() / 1000);
  const mint = async (
    subject: string,
    overrides: Record<string, unknown> = {},
    key = oidc.privateKey,
  ) =>
    new SignJWT({
      iss: bindings.TELESTRA_OIDC_ISSUER,
      aud: bindings.TELESTRA_OIDC_AUDIENCE,
      sub: subject,
      iat: now(),
      exp: now() + 600,
      jti: crypto.randomUUID(),
      ...overrides,
    })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: oidc.publicJwk.kid,
        typ: "at+jwt",
      })
      .sign(key);
  const browser = async (
    path: string,
    token: string,
    options: {
      method?: string;
      body?: unknown;
      origin?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.origin !== null) headers.Origin = options.origin ?? origin;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined)
      headers["Content-Type"] = "application/json";
    return mf.dispatchFetch(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  };
  const agent = async (path: string, token = "", value?: unknown) =>
    mf.dispatchFetch(`http://localhost${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(value !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
  const deviceProof = async (
    target: Device,
    purpose: "join" | "rotate" | "connect",
    challenge: string,
    overrides: Record<string, unknown> = {},
  ) =>
    new SignJWT({
      iss: target.nodeId,
      aud: "tv-node-device-proof",
      sub: target.nodeId,
      iat: now(),
      exp: now() + 60,
      jti: crypto.randomUUID(),
      tenantId,
      environment: "development",
      nodeId: target.nodeId,
      purpose,
      challengeHash: await digest(challenge),
      ...overrides,
    })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: target.publicJwk.kid,
        typ: "tv-device-proof+jwt",
      })
      .sign(target.privateKey);
  const register = async (
    target: Device,
    operatorToken: string,
    nodeRole: "tuner" | "encoder" = "tuner",
  ) =>
    browser("/nodes", operatorToken, {
      method: "POST",
      body: {
        nodeId: target.nodeId,
        nodeRole,
        publicKey: target.publicJwk,
      },
    });
  const challenge = async (target: Device, operatorToken: string) => {
    const response = await browser("/nodes/challenges", operatorToken, {
      method: "POST",
      body: { nodeId: target.nodeId },
    });
    const value = (await response.json()) as { code?: unknown };
    if (response.status !== 200 || typeof value.code !== "string")
      throw new Error("テスト用の参加権利を発行できませんでした。");
    return value.code;
  };
  // 再起動では移行とseedを再実行せず、同じD1保存先を再利用して永続性を確かめる。
  const restart = async () => {
    const address = await mf.ready;
    await mf.dispose();
    // 実WSSの試験では接続先を変えず、Goの再接続を同じポートで受け付ける。
    mf = new Miniflare({
      ...options,
      ...(tls ? { port: Number(address.port) } : {}),
    });
    database = await mf.getD1Database("TELESTRA_DB");
  };
  return {
    bindings,
    signer,
    mint,
    // Mock IdPのcode交換でだけ使い、ID TokenをAPIのAccess Tokenと混同しない。
    mintIdToken: async (
      subject: string,
      nonce: string,
      overrides: Record<string, unknown> = {},
      key = oidc.privateKey,
    ) =>
      new SignJWT({
        iss: bindings.TELESTRA_OIDC_ISSUER,
        aud: "telestra-browser-local",
        sub: subject,
        iat: now(),
        exp: now() + 600,
        nonce,
        ...overrides,
      })
        .setProtectedHeader({
          alg: "EdDSA",
          kid: oidc.publicJwk.kid,
          typ: "JWT",
        })
        .sign(key),
    browser,
    agent,
    deviceProof,
    register,
    challenge,
    restart,
    get database() {
      return database;
    },
    get mf() {
      return mf;
    },
    get egress() {
      return egress;
    },
    now,
    decode: decodeJwt,
    close: async () => {
      await mf.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
