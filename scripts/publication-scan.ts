// 公開候補とGitの全参照のblobを検査する。検出値や秘密の本文は出力しない。
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface Finding {
  path: string;
  line: number;
  rule: string;
}
export function scanText(path: string, text: string): Finding[] {
  const rules: [string, RegExp][] = [
    ["PRIVATE_KEY", /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/g],
    [
      "ACCESS_TOKEN",
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/g,
    ],
    ["HOME_PATH", /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//g],
    [
      "PRIVATE_HOST",
      /(?:https?:\/\/|wss?:\/\/)[a-zA-Z0-9-]+\.(?:local|lan|home|internal)\b/g,
    ],
    ["HARDWARE_ID", /\b(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}\b/g],
    [
      "LITERAL_CREDENTIAL",
      /(?:password|api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*["'][A-Za-z0-9_+\/-]{20,}["']/gi,
    ],
    [
      "ENVIRONMENT_ID",
      /(?:zone|tunnel|account)[_-]?id["']?\s*[:=]\s*["'][a-fA-F0-9-]{20,}["']/gi,
    ],
  ];
  const result: Finding[] = [];
  for (const [rule, pattern] of rules)
    for (const match of text.matchAll(pattern))
      result.push({
        path,
        line: text.slice(0, match.index).split("\n").length,
        rule,
      });
  // IPv4はloopbackと文書用の3ブロックだけを許可する。値自体はレポートに含めない。
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const parts = match[0].split(".").map(Number);
    if (parts.some((x) => x > 255)) continue;
    if (
      parts[0] === 127 ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
      (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
    )
      continue;
    result.push({
      path,
      line: text.slice(0, match.index).split("\n").length,
      rule: "NON_DOCUMENTATION_IP",
    });
  }
  for (const match of text.matchAll(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  )) {
    const domain = match[0].split("@")[1] ?? "";
    // GitHubが付ける公開noreplyの履歴情報は私的メールと区別する。
    const platformMetadata =
      path === "history:metadata" &&
      (domain === "users.noreply.github.com" ||
        (domain === "github.com" && match[0].split("@")[0] === "noreply"));
    if (platformMetadata) continue;
    if (
      domain.endsWith(".invalid") ||
      domain.endsWith(".test") ||
      domain === "example.com"
    )
      continue;
    result.push({
      path,
      line: text.slice(0, match.index).split("\n").length,
      rule: "EMAIL_REVIEW",
    });
  }
  return result;
}

export function publicationScan(directory: string): {
  findings: Finding[];
  history: "checked" | "unavailable";
  files: number;
  blobs: number;
} {
  let files: string[] = [];
  let history: "checked" | "unavailable" = "unavailable";
  let blobs = 0;
  try {
    files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    const walk = (part: string) => {
      for (const entry of readdirSync(join(directory, part), {
        withFileTypes: true,
      })) {
        if (
          [
            "node_modules",
            "artifacts",
            ".git",
            ".terraform",
            "__pycache__",
          ].includes(entry.name)
        )
          continue;
        const name = join(part, entry.name);
        if (entry.isDirectory()) walk(name);
        else files.push(name);
      }
    };
    walk("");
  }
  const findings: Finding[] = [];
  for (const name of files) {
    const path = join(directory, name);
    if (
      /(?:^|\/)(?:\.env(?:\.|$)|[^/]*\.(?:pem|key|p12|pfx|tfstate)(?:\.|$))/.test(
        name,
      )
    ) {
      findings.push({ path: name, line: 1, rule: "FORBIDDEN_FILE" });
      continue;
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 2_097_152) {
      findings.push({ path: name, line: 1, rule: "FILE_REVIEW" });
      continue;
    }
    findings.push(...scanText(name, readFileSync(path, "utf8")));
  }
  try {
    const metadata = execFileSync(
      "git",
      ["log", "--all", "--format=%H%n%an <%ae>%n%cn <%ce>%n%B"],
      {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 2_097_152,
      },
    );
    findings.push(...scanText("history:metadata", metadata));
    const objects = execFileSync("git", ["rev-list", "--objects", "--all"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8_388_608,
    });
    for (const line of objects.trim().split("\n")) {
      const [sha, ...path] = line.split(" ");
      if (!sha || !/^[a-f0-9]{40}$/.test(sha) || path.length === 0) continue;
      const kind = execFileSync("git", ["cat-file", "-t", sha], {
        cwd: directory,
        encoding: "utf8",
      }).trim();
      if (kind !== "blob") continue;
      const text = execFileSync("git", ["cat-file", "blob", sha], {
        cwd: directory,
        encoding: "utf8",
        maxBuffer: 2_097_152,
      });
      blobs++;
      findings.push(...scanText(`history:${sha}:${path.join(" ")}`, text));
    }
    history = blobs > 0 ? "checked" : "unavailable";
  } catch {
    history = "unavailable";
  }
  return { findings, history, files: files.length, blobs };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const result = publicationScan(process.cwd());
  console.log(JSON.stringify(result, null, 2));
  if (
    result.findings.length ||
    (process.argv.includes("--require-history") && result.history !== "checked")
  )
    process.exitCode = 1;
}
