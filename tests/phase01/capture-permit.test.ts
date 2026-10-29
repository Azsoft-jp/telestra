// 実workerdとGoでv2の署名・境界を照合する。録画実行や本番への接続は行わない。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { generateKeyPair, exportJWK } from "jose";
import type { ControlMap } from "../../packages/control-contracts/index.ts";
import { CapturePermitVerifier } from "../../packages/capture-permit/index.ts";
import { permitCases } from "../fixtures/permit-cases.ts";
import { permitClaims, permitContext } from "../fixtures/permit.ts";
import { scenario } from "../evidence.ts";
// 固定実行ファイルの応答をメモリ内で解析し、異常時も署名や秘密のIPC本文を表示しない。
function exchange(
  binary: string,
  value: unknown,
): { ok: boolean; results?: string[]; signed?: string } {
  const result = spawnSync(binary, [], {
    input: JSON.stringify(value),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1_048_576,
  });
  assert.equal(result.status, 0, "Goのv2試験プロセスが失敗しました。");
  try {
    return JSON.parse(result.stdout) as ReturnType<typeof exchange>;
  } catch {
    throw new Error("Goのv2試験応答を確認してください。");
  }
}

scenario(
  "PERMIT-02",
  "node-go-workerd-shared-negative-matrix",
  "memory-only-keys-cross-runtime-v2",
  "同じ正常・異常入力を3実装で照合し、Goの署名もNodeとWorkerが検証する",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "telestra-permit-"));
    let worker: Miniflare | undefined;
    let egress = 0;
    try {
      const binary = join(directory, "permitfixture");
      const built = spawnSync(
        "go",
        ["build", "-o", binary, "./nodes/tuner/cmd/permitfixture"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            GOTOOLCHAIN: "local",
            GOPROXY: "off",
            GOSUMDB: "off",
          },
        },
      );
      assert.equal(built.status, 0, "Goのv2試験器をビルドできませんでした。");
      const keyPair = await generateKeyPair("Ed25519", { extractable: true });
      const privateJwk = await exportJWK(keyPair.privateKey);
      const key = {
        ...(await exportJWK(keyPair.publicKey)),
        alg: "Ed25519",
        kid: "permit-key-02",
      };
      const verifier = await CapturePermitVerifier.create(permitClaims.iss, [
        key,
      ]);
      const cases = await permitCases(keyPair.privateKey, key.kid);
      const signed = exchange(binary, {
        issuer: permitClaims.iss,
        keys: [key],
        cases: [],
        privateSeed: privateJwk.d,
        claims: permitClaims,
      });
      assert.equal(
        signed.ok && typeof signed.signed === "string",
        true,
        "Goが合成許可を署名できる",
      );
      if (typeof signed.signed !== "string")
        throw new Error("Goの署名がありません。");
      cases.push({
        label: "go-signature",
        token: signed.signed,
        context: permitContext,
        expected: "active",
      });
      assert.equal(cases.length, 110, "共有するv2境界ケースは110件");
      const bundle = await build({
        entryPoints: ["tests/fixtures/permit-worker.ts"],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2023",
      });
      worker = new Miniflare({
        cf: false,
        host: "127.0.0.1",
        port: 0,
        modules: true,
        script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-07-30",
        log: new Log(LogLevel.ERROR),
        outboundService: () => {
          egress++;
          return new Response("通信禁止", { status: 403 });
        },
      });
      for (let start = 0; start < cases.length; start += 32) {
        const group = cases.slice(start, start + 32);
        const input = {
          issuer: permitClaims.iss,
          keys: [key],
          cases: group.map(({ token, context }) => ({ token, context })),
        };
        const expected = group.map((item) => item.expected);
        const fromGo = exchange(binary, input);
        assert.equal(fromGo.ok, true, "Goが試験入力を受け付ける");
        assert.deepEqual(
          fromGo.results,
          expected,
          group.map((item) => item.label).join(","),
        );
        const response: Awaited<ReturnType<Miniflare["dispatchFetch"]>> =
          await worker.dispatchFetch("http://localhost/verify", {
            method: "POST",
            body: JSON.stringify(input),
          });
        assert.equal(response.status, 200, "Workerが試験入力を受け付ける");
        const fromWorker = (await response.json()) as {
          ok: boolean;
          results: string[];
        };
        assert.deepEqual(
          fromWorker.results,
          expected,
          group.map((item) => item.label).join(","),
        );
        for (const item of group) {
          let actual: string = "rejected";
          try {
            actual = (
              await verifier.verify(
                item.token,
                item.context as ControlMap["CapturePermitV2Context"],
              )
            ).window;
          } catch {
            /* 拒否の詳細に受信値を含めない。 */
          }
          assert.equal(actual, item.expected, item.label);
        }
      }
      assert.equal(egress, 0, "Workerから外部取得しない");
    } finally {
      await worker?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
