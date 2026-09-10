import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";

const image =
  "ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
if (
  execFileSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim() ===
  "true"
) {
  throw new Error("Full Git history required: use checkout fetch-depth: 0.");
}
const reportDir = process.argv[2] ? resolve(process.argv[2]) : null;
if (reportDir) mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const snapshot = mkdtempSync(join(tmpdir(), "immojudis-secret-scan-"));
try {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  for (const path of new Set(paths)) {
    const source = resolve(root, path);
    if (relative(root, source).startsWith("..")) throw new Error("Invalid repository path");
    let stat;
    try {
      stat = lstatSync(source);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const target = join(snapshot, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  for (const [mode, source, extra] of [
    ["git", root, ["--log-opts=--all"]],
    ["dir", snapshot, []],
  ]) {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${source}:/repo:ro`,
        ...(reportDir ? ["-v", `${reportDir}:/reports`] : []),
        image,
        mode,
        "/repo",
        ...extra,
        "--redact=100",
        "--gitleaks-ignore-path=/repo/.gitleaksignore",
        "--no-banner",
        "--timeout=300",
        ...(reportDir ? ["--report-format=json", `--report-path=/reports/${mode}.json`] : []),
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
    }
  }
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
