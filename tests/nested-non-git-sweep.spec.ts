import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(repo, "docs", "operator", "nested-non-git-sweep.mjs");

let scratch: string;
let root: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "nested-non-git-sweep-"));
  root = join(scratch, "worktrees");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function nestedPath(name: string): string {
  return join(root, "project", "branch", ".paperclip-repositories", name);
}

function nested(name: string): string {
  const path = nestedPath(name);
  mkdirSync(path, { recursive: true });
  return path;
}

function runSweep(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(process.execPath, [SCRIPT, path], {
    cwd: repo,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runSweepResult(path: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [SCRIPT, path], {
    cwd: repo,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initGitRepo(path: string): void {
  execFileSync("git", ["init", "--quiet", path], { cwd: repo });
}

describe("nested non-git operator sweep", () => {
  it("matches the host adoption rule for .git directories and files", () => {
    const empty = nested("empty-git-dir");
    mkdirSync(join(empty, ".git"));

    const target = join(scratch, "not-a-git-directory");
    writeFileSync(target, "not a directory\n");
    const pointer = nested("pointer-to-file");
    writeFileSync(join(pointer, ".git"), `gitdir: ${target}\n`);

    const output = runSweep(root);
    const hits = output.split("\n").filter((line) => line.startsWith("HIT "));

    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(".paperclip-repositories/pointer-to-file");
    expect(hits[0]?.endsWith("non-directory-git-entry")).toBe(true);
    expect(output).not.toContain("empty-git-dir");
    expect(output).toContain("SUMMARY workspaces=2 nested-not-adoptable=1 scan-errors=0");
  });

  it("follows .git directory symlinks and rejects linked-worktree pointer files", () => {
    const healthyDir = nested("healthy-git-dir");
    initGitRepo(healthyDir);

    const source = join(scratch, "source");
    initGitRepo(source);
    execFileSync("git", ["-C", source, "config", "user.name", "Sweep Test"], { cwd: repo });
    execFileSync("git", ["-C", source, "config", "user.email", "sweep@example.invalid"], {
      cwd: repo,
    });
    writeFileSync(join(source, "README.md"), "fixture\n");
    execFileSync("git", ["-C", source, "add", "README.md"], { cwd: repo });
    execFileSync("git", ["-C", source, "commit", "--quiet", "-m", "fixture"], { cwd: repo });

    const symlinkCheckout = nested("symlink-git-dir");
    symlinkSync(join(source, ".git"), join(symlinkCheckout, ".git"), "dir");

    const linkedWorktree = nestedPath("linked-worktree-file");
    mkdirSync(dirname(linkedWorktree), { recursive: true });
    execFileSync(
      "git",
      ["-C", source, "worktree", "add", "--quiet", "-b", "sweep-test", linkedWorktree, "HEAD"],
      { cwd: repo },
    );

    const output = runSweep(root);
    const hits = output.split("\n").filter((line) => line.startsWith("HIT "));

    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(".paperclip-repositories/linked-worktree-file");
    expect(hits[0]?.endsWith("non-directory-git-entry")).toBe(true);
    expect(output).not.toContain(".paperclip-repositories/healthy-git-dir");
    expect(output).not.toContain(".paperclip-repositories/symlink-git-dir");
    expect(output).toContain("SUMMARY workspaces=2 nested-not-adoptable=1 scan-errors=0");
  });

  it("distinguishes missing, dangling, and unresolvable .git entries", () => {
    nested("missing-git-entry");

    const dangling = nested("dangling-git-entry");
    symlinkSync(join(scratch, "missing-gitdir"), join(dangling, ".git"), "dir");

    const looped = nested("looped-git-entry");
    symlinkSync(".git", join(looped, ".git"));

    const output = runSweep(root);
    const hits = output.split("\n").filter((line) => line.startsWith("HIT "));

    expect(hits).toHaveLength(3);
    expect(
      hits.some((line) => line.includes(".paperclip-repositories/missing-git-entry") && line.endsWith("missing")),
    ).toBe(true);
    expect(
      hits.some((line) => line.includes(".paperclip-repositories/dangling-git-entry") && line.endsWith("dead-gitdir")),
    ).toBe(true);
    expect(
      hits.some(
        (line) =>
          line.includes(".paperclip-repositories/looped-git-entry") && line.endsWith("unverifiable-gitdir"),
      ),
    ).toBe(true);
    expect(output).toContain("SUMMARY workspaces=2 nested-not-adoptable=3 scan-errors=0");
  });

  it("reports .git files when git and du cannot be invoked", () => {
    const checkout = nested("gitfile-without-tools");
    writeFileSync(join(checkout, ".git"), "gitdir: missing\n");
    const emptyPath = join(scratch, "no-git-path");
    mkdirSync(emptyPath);

    const output = runSweep(root, { ...process.env, PATH: emptyPath });

    expect(output).toContain(".paperclip-repositories/gitfile-without-tools");
    expect(output).toContain("non-directory-git-entry");
    expect(output).toContain("size-unknown");
  });

  it("exits nonzero when a requested root cannot be scanned", () => {
    const result = runSweepResult(join(scratch, "missing-root"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WARN cannot list root");
    expect(result.stdout).toContain("SUMMARY workspaces=0 nested-not-adoptable=0 scan-errors=1");
  });
});
