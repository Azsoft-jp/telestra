// 必須試験IDと証跡の項目を照合し、不足や失敗を合格として扱わない。
const phase00TestIds = ["CORE-01", "CORE-02", "MED-01"] as const;

interface Evidence {
  testId: string;
  name: string;
  commit: string | null;
  environment: string;
  fixtureId: string;
  expected: string;
  actual: string;
  status: "pass" | "fail" | "skip";
  evidenceUri: string;
  timestamp: string;
}

function isEvidence(value: unknown): value is Evidence {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  const textFields = [
    "testId",
    "name",
    "environment",
    "fixtureId",
    "expected",
    "actual",
    "evidenceUri",
    "timestamp",
  ] as const;
  if (
    !textFields.every(
      (field) =>
        typeof record[field] === "string" &&
        record[field].trim().length > 0 &&
        record[field].length <= 16_384,
    )
  )
    return false;
  return (
    (record.commit === null || typeof record.commit === "string") &&
    /^[A-Z0-9]+-[0-9]{2}$/.test(record.testId as string) &&
    ["pass", "fail", "skip"].includes(record.status as string) &&
    Number.isFinite(Date.parse(record.timestamp as string)) &&
    (record.evidenceUri as string).startsWith("artifacts/") &&
    !(record.evidenceUri as string).split("/").includes("..")
  );
}

// 必須IDの合格記録だけを確認し、後続Phaseを検証済みとは扱わない。
export function evaluateAcceptance(
  records: readonly unknown[],
  execution: { exitCode: number | null; executionError: boolean },
  requiredTestIds: readonly string[] = phase00TestIds,
): {
  status: "pass" | "fail";
  requiredTestIds: readonly string[];
  missingTestIds: string[];
  issues: string[];
} {
  const issues = new Set<string>();
  if (execution.exitCode !== 0 || execution.executionError !== false)
    issues.add("EXECUTION_FAILED");
  const passedIds = new Set<string>();
  const names = new Set<string>();
  for (const record of records) {
    if (!isEvidence(record)) {
      issues.add("INVALID_EVIDENCE");
      continue;
    }
    const key = `${record.testId}\0${record.name}`;
    if (names.has(key)) issues.add("DUPLICATE_EVIDENCE");
    names.add(key);
    if (record.status === "pass") passedIds.add(record.testId);
    else issues.add("NON_PASSING_EVIDENCE");
  }
  const missingTestIds = requiredTestIds.filter(
    (testId) => !passedIds.has(testId),
  );
  if (missingTestIds.length > 0) issues.add("MISSING_REQUIRED_TEST_IDS");
  return {
    status: issues.size === 0 ? "pass" : "fail",
    requiredTestIds,
    missingTestIds,
    issues: [...issues],
  };
}
