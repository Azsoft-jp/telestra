// 合成した禁止情報を使い、スキャンが値をレポートへ転記せず、既知の文書用値を許すか確認する。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { scanText, publicationScan } from "../scripts/publication-scan.ts";
import { scenario } from "./evidence.ts";

scenario(
  "PUB-01",
  "public-information-and-history-guard",
  "synthetic-forbidden-text-v1",
  "秘密・私的IP・端末パスを検出し、値を返さず、削除済みのGit blobも検出する",
  () => {
    const token = "gh" + "p_" + "A".repeat(36);
    const address = [10, 20, 30, 40].join(".");
    const privateText =
      `access=${token}\nhttp://${address}/\n/` +
      "Users" +
      "/example-user/private/";
    const findings = scanText("example.txt", privateText);
    assert.ok(findings.some((x) => x.rule === "ACCESS_TOKEN"));
    assert.ok(findings.some((x) => x.rule === "NON_DOCUMENTATION_IP"));
    assert.ok(findings.some((x) => x.rule === "HOME_PATH"));
    assert.equal(JSON.stringify(findings).includes(token), false);
    assert.equal(JSON.stringify(findings).includes(address), false);
    assert.deepEqual(
      scanText(
        "example.txt",
        "http://127.0.0.1:5173\nhttps://primary.example.invalid\nhttp://192.0.2.1/\nexamples/deployment.local.json",
      ),
      [],
    );
    const directory = mkdtempSync(join(tmpdir(), "telestra-history-"));
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Telestra test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd: directory, stdio: "ignore" },
      );
    try {
      git("init", "-q");
      writeFileSync(join(directory, "example.txt"), privateText);
      git("add", "example.txt");
      git("commit", "-qm", "Synthetic fixture");
      writeFileSync(join(directory, "example.txt"), "safe");
      git("add", "example.txt");
      git("commit", "-qm", "Remove fixture");
      const result = publicationScan(directory);
      assert.equal(result.history, "checked");
      assert.ok(result.findings.some((x) => x.path.startsWith("history:")));
      assert.ok(result.blobs >= 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
