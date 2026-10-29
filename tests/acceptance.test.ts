// 証跡の不足・不正・失敗を合格にしないことを、検査器の自己試験で確認する。
import assert from "node:assert/strict";
import { evaluateAcceptance } from "../scripts/acceptance-gate.ts";
import { scenario } from "./evidence.ts";

scenario(
  "PH00-01",
  "acceptance-evidence-integrity",
  "synthetic-evidence-v1",
  "必須ID不足・skip・fail・重複・不正な証跡と試験プロセス異常を合格にしない",
  () => {
    const sample = (testId: string) => ({
      testId,
      name: `fixture-${testId}`,
      commit: null,
      environment: "unit-fixture-only",
      fixtureId: "synthetic-evidence-v1",
      expected: "検査器の自己試験",
      actual: "検査器の自己試験",
      status: "pass",
      evidenceUri: "artifacts/unit-fixture.txt",
      timestamp: "2026-10-29T00:00:30Z",
    });
    const complete = ["CORE-01", "CORE-02", "MED-01"].map(sample);
    const success = { exitCode: 0, executionError: false };
    assert.equal(evaluateAcceptance(complete, success).status, "pass");
    // 部分試験用のID指定でも、不足する試験を合格にしない。
    assert.equal(
      evaluateAcceptance([sample("NODE-01")], success, ["NODE-01"]).status,
      "pass",
    );
    assert.deepEqual(
      evaluateAcceptance([sample("NODE-01")], success, ["NODE-01", "SEC-03"])
        .missingTestIds,
      ["SEC-03"],
    );
    assert.deepEqual(evaluateAcceptance([], success).missingTestIds, [
      "CORE-01",
      "CORE-02",
      "MED-01",
    ]);
    assert.deepEqual(
      evaluateAcceptance(complete.slice(0, 2), success).missingTestIds,
      ["MED-01"],
    );
    for (const status of ["skip", "fail", "unknown"]) {
      const evidence = complete.map((record) =>
        record.testId === "MED-01" ? { ...record, status } : record,
      );
      assert.equal(evaluateAcceptance(evidence, success).status, "fail");
    }
    assert.equal(
      evaluateAcceptance([...complete, complete[0]], success).status,
      "fail",
    );
    for (const malformed of [
      null,
      {},
      { ...sample("MED-01"), timestamp: "not-a-date" },
      { ...sample("MED-01"), expected: "" },
    ]) {
      assert.equal(
        evaluateAcceptance([...complete, malformed], success).status,
        "fail",
      );
    }
    for (const execution of [
      { exitCode: 1, executionError: false },
      { exitCode: null, executionError: true },
      { exitCode: 0, executionError: true },
    ]) {
      assert.equal(evaluateAcceptance(complete, execution).status, "fail");
    }
  },
);
