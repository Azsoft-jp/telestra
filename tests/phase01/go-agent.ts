// GoからローカルWorkerへTLS検証付きで接続し、IPCの鍵や資格を証跡へ残さず検証する。
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exportJWK } from "jose";
import { tenantId } from "./helper.ts";
import type { Fixture } from "./helper.ts";
import type { Enrolled } from "./socket.ts";
import { publicKeys, verifyIdentity } from "../../packages/identity/index.ts";

const directory = mkdtempSync(join(tmpdir(), "tv-go-wss-test-"));
const executable = join(directory, "controlfixture");
const environment = {
  ...process.env,
  GOTOOLCHAIN: "local",
  GOPROXY: "off",
  GOSUMDB: "off",
};

// 固定したfixtureコマンドを構築する。引数や出力へ秘密値を含めない。
before(() => {
  const built = spawnSync(
    "go",
    ["build", "-o", executable, "./nodes/tuner/cmd/controlfixture"],
    { encoding: "utf8", env: environment, timeout: 30_000 },
  );
  assert.equal(built.status, 0, "GoのWSS試験コマンドを構築できません。");
});
after(() => rmSync(directory, { recursive: true, force: true }));

export function tlsMaterial(): { certificate: string; key: string } {
  const result = spawnSync(executable, [], {
    input: JSON.stringify({ mode: "tls-material" }),
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16_384,
    env: environment,
  });
  assert.equal(result.status, 0, "試験用のTLS証明書を生成できません。");
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("試験用のTLS応答を解析できません。");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("certificate" in value) ||
    typeof value.certificate !== "string" ||
    !("key" in value) ||
    typeof value.key !== "string"
  )
    throw new Error("試験用のTLS応答の形式が不正です。");
  return { certificate: value.certificate, key: value.key };
}

export interface Progress {
  rotations?: number;
  generation?: number;
  state?: string;
  attempt?: number;
  done?: boolean;
  attempts?: number;
  epoch?: number;
  code?: string;
}

// 進捗の欄へ資格本文が混入しても表示しない。型・値・項目数を限定してから親試験へ渡す。
function progress(value: unknown): Progress {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("進捗の形式が不正です。");
  const states = [
    "connecting",
    "connected",
    "reconnecting",
    "stopped",
    "failed",
    "completed",
    "joined",
    "rotated",
    "restored",
    "refreshing",
    "refreshed",
  ];
  const codes = [
    "transport",
    "credentials",
    "protocol",
    "stopped",
    "completed",
    "fixture-failed",
    "recovery-required",
    "close-failed",
    "journal",
  ];
  for (const [name, field] of Object.entries(value)) {
    if (name === "state") {
      if (typeof field !== "string" || !states.includes(field))
        throw new Error("進捗の状態が不正です。");
    } else if (name === "code") {
      if (typeof field !== "string" || !codes.includes(field))
        throw new Error("進捗の分類が不正です。");
    } else if (name === "done") {
      if (typeof field !== "boolean")
        throw new Error("進捗の完了状態が不正です。");
    } else if (
      ["rotations", "generation", "attempt", "attempts", "epoch"].includes(name)
    ) {
      if (
        typeof field !== "number" ||
        !Number.isSafeInteger(field) ||
        field < 0
      )
        throw new Error("進捗の件数が不正です。");
    } else throw new Error("進捗の項目が不正です。");
  }
  return value as Progress;
}

// 子プロセスの出力は状態だけを受け付け、サイズ上限と有限の待機を設ける。
export async function agent(
  context: Fixture,
  enrolled: Pick<Enrolled, "target"> & {
    credential?: Enrolled["credential"];
    joinCode?: string;
    lifecycle?: boolean;
    checkpoint?: boolean;
    processMode?: "persist-run" | "restore-run";
    checkpointId?: string;
    endpoint?: string;
  },
  certificate: string,
) {
  const key = await exportJWK(enrolled.target.privateKey);
  const ready = await context.mf.ready;
  const endpoint = enrolled.endpoint
    ? new URL(enrolled.endpoint)
    : new URL("/agent", ready);
  if (!enrolled.endpoint) endpoint.protocol = "wss:";
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.pathname !== "/agent" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("試験用のloopback接続先が不正です。");
  const child = spawn(executable, [], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const records: Progress[] = [];
  let buffer = "";
  let bytes = 0;
  let invalid = false;
  let ended = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let outputError = false;
  const closed = new Promise<void>((resolve) =>
    child.once("close", (code, signal) => {
      ended = true;
      exitCode = code;
      exitSignal = signal;
      resolve();
    }),
  );
  child.on("error", () => {
    invalid = true;
  });
  child.stdin.on("error", () => {
    invalid = true;
  });
  child.stderr.on("data", () => {
    outputError = true;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16_384) {
      invalid = true;
      child.kill("SIGTERM");
      return;
    }
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      try {
        records.push(progress(JSON.parse(line) as unknown));
      } catch {
        invalid = true;
      }
    }
  });
  // 専用pipeで受け取った資格は署名・用途・端末・世代を検証し、親のメモリだけに保持する。
  const credentials = new Map<number, string>();
  let secretBuffer = "",
    secretBytes = 0,
    lastGeneration = 0;
  let secretWork = Promise.resolve();
  const secret = child.stdio[3];
  if (!secret || !("setEncoding" in secret))
    throw new Error("資格の試験用pipeを作成できません。");
  secret.setEncoding("utf8");
  secret.on("data", (chunk: string) => {
    secretBytes += Buffer.byteLength(chunk);
    if (secretBytes > 24_576) {
      invalid = true;
      child.kill("SIGTERM");
      return;
    }
    secretBuffer += chunk;
    let boundary: number;
    while ((boundary = secretBuffer.indexOf("\n")) >= 0) {
      const line = secretBuffer.slice(0, boundary);
      secretBuffer = secretBuffer.slice(boundary + 1);
      secretWork = secretWork
        .then(async () => {
          const value = JSON.parse(line) as {
            accessToken?: unknown;
            generation?: unknown;
          };
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(",") !== "accessToken,generation" ||
            typeof value.accessToken !== "string" ||
            typeof value.generation !== "number" ||
            !Number.isSafeInteger(value.generation) ||
            value.generation <= lastGeneration ||
            enrolled.processMode !== "persist-run"
          )
            throw new Error("資格の通知が不正です。");
          const claims = await verifyIdentity("NodeClaims", value.accessToken, {
            issuer: context.bindings.TELESTRA_CONTROL_ISSUER,
            audience: "tv-node-agent",
            typ: "tv-node+jwt",
            jwks: publicKeys(context.bindings.TELESTRA_CONTROL_PUBLIC_JWKS),
            now: context.now(),
            maxLifetime: 300,
          });
          if (
            claims.nodeId !== enrolled.target.nodeId ||
            claims.tenantId !== tenantId ||
            claims.environment !== "development" ||
            claims.nodeRole !== "tuner" ||
            claims.credentialVersion !== value.generation
          )
            throw new Error("資格の端末境界が不正です。");
          credentials.set(value.generation, value.accessToken);
          lastGeneration = value.generation;
        })
        .catch(() => {
          invalid = true;
        });
    }
  });
  secret.on("error", () => {
    invalid = true;
  });
  child.stdin.end(
    JSON.stringify({
      mode:
        enrolled.processMode ??
        (enrolled.checkpoint
          ? "checkpoint-run"
          : enrolled.lifecycle
            ? "lifecycle-run"
            : enrolled.joinCode
              ? "provision-run"
              : "run"),
      checkpointId: enrolled.checkpointId ?? "",
      endpoint: endpoint.toString(),
      rootPEM: certificate,
      issuer: context.bindings.TELESTRA_CONTROL_ISSUER,
      keys: [context.signer.publicJwk],
      identity: {
        NodeID: enrolled.target.nodeId,
        TenantID: tenantId,
        Environment: "development",
        Role: "tuner",
      },
      credential: enrolled.credential?.accessToken ?? "",
      joinCode: enrolled.joinCode ?? "",
      privateSeed: key.d,
      deviceKeyID: enrolled.target.publicJwk.kid,
    }),
  );
  const wait = async (
    predicate: (record: Progress) => boolean,
    timeout = 10_000,
  ): Promise<Progress> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (invalid || outputError) throw new Error("Goの状態通知が不正です。");
      const value = records.find(predicate);
      if (value) return value;
      if (ended) throw new Error("Goが期待した状態になる前に終了しました。");
      await delay(25);
    }
    throw new Error("Goの状態通知が時間内に届きません。");
  };
  return {
    wait,
    credential: async (generation: number): Promise<Enrolled["credential"]> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await secretWork;
        if (invalid) throw new Error("資格の通知を確認できません。");
        const token = credentials.get(generation);
        if (token) return { accessToken: token, credentialVersion: generation };
        if (ended) throw new Error("資格の通知前に終了しました。");
        await delay(25);
      }
      throw new Error("資格の通知が時間内に届きません。");
    },
    crash: () => {
      if (!child.kill("SIGKILL"))
        throw new Error("試験プロセスを強制終了できません。");
    },
    // 失敗時もGoを終了させ、Miniflareを破棄する前に接続を回収する。
    close: async (expected: number | "SIGKILL" = 0) => {
      // 完了通知後はGoがsignal handlerを解放している場合があるため、SIGTERMを重ねない。
      // まだ実行中の場合だけ中断し、通知済みの場合も5秒の終了期限は維持する。
      if (
        expected !== "SIGKILL" &&
        !ended &&
        !records.some((record) => record.done === true)
      )
        child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("Goを終了できません。"));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await secretWork;
      if (expected === "SIGKILL") {
        assert.equal(
          exitSignal,
          "SIGKILL",
          "試験プロセスの強制終了を確認できません。",
        );
      } else
        assert.equal(exitCode, expected, "GoのWSS試験プロセスが失敗しました。");
      assert.equal(secretBuffer.length, 0, "資格の通知が途中で切れました。");
      assert.equal(
        invalid || outputError,
        false,
        "Goの通知または終了処理が不正です。",
      );
    },
  };
}
