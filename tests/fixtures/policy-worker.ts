// 実workerdでpolicyとPermitの検証を照合する試験入口。配備用APIには使わない。
import { readBounded } from "./permit-worker.ts";
import { strictJson } from "../../packages/capture-permit/json.ts";
import { CapturePermitVerifier } from "../../packages/capture-permit/index.ts";
import { CapturePolicyVerifier } from "../../packages/capture-permit/policy.ts";
import type { PolicyIdentity } from "../../packages/capture-permit/policy.ts";
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const input = strictJson(await readBounded(request), 1048576) as {
        issuer: string;
        policyKeys: unknown[];
        permitKeys: unknown[];
        identity: PolicyIdentity;
        maxLifetime: number;
        cases: {
          policy: string;
          permit: string;
          now: number;
          maxObserved: number;
        }[];
      };
      if (
        request.method !== "POST" ||
        !Array.isArray(input.cases) ||
        input.cases.length > 128
      )
        throw new Error("試験入力を確認してください。");
      const policy = await CapturePolicyVerifier.create(
          input.issuer,
          input.policyKeys,
          input.maxLifetime,
        ),
        permit = await CapturePermitVerifier.create(
          input.issuer,
          input.permitKeys,
        );
      const results = [];
      for (const item of input.cases) {
        try {
          const result = await policy.verifyPermit(
            item.policy,
            item.permit,
            permit,
            input.identity,
            item.now,
            item.maxObserved,
          );
          results.push(
            result.executionAuthorized === false ? result.window : "rejected",
          );
        } catch {
          results.push("rejected");
        }
      }
      return Response.json({ results });
    } catch {
      return Response.json({ ok: false }, { status: 400 });
    }
  },
};
