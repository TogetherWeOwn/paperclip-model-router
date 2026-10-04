/**
 * Guard suite for scripts/ci-changes.mjs and the change gating in ci.yml
 * (decision 0013: CI runs only what the change affects).
 *
 * The failure this suite exists to prevent is the quiet one: a gate that skips
 * `verify` when it should have run. A skipped job is not a failed job, so a
 * wrong skip reads as a green PR. Every test here is either "this change must
 * run everything" or "the gate cannot report green by skipping by accident".
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface Classified {
  code: boolean;
  reason: string;
}
interface CiChanges {
  DOCS_ONLY: RegExp[];
  classify(files: readonly string[]): Classified;
  detect(
    env: { EVENT_NAME?: string; BASE_SHA?: string; HEAD_SHA?: string },
    git: (args: string[]) => string,
  ): Classified & { files?: string[] };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "ci-changes.mjs");
const specifier = new URL("../scripts/ci-changes.mjs", import.meta.url).href;
const ci: CiChanges = await import(/* @vite-ignore */ specifier);
const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

describe("classify: only inert documentation may skip the heavy job", () => {
  it.each([
    ["CONTRIBUTING.md"],
    ["AGENTS.md"],
    ["docs/decisions/0013-ci-runs-only-what-the-change-affects.md"],
    ["docs/security/leaked-token-response-runbook.md"],
  ])("%s alone skips verify", (file) => {
    expect(ci.classify([file]).code).toBe(false);
  });

  it("several allow-listed docs together still skip", () => {
    expect(ci.classify(["AGENTS.md", "docs/decisions/0001-x.md", "docs/security/a/b.md"]).code).toBe(false);
  });

  // The "full-run triggers" of the CI standard: dependency manifests and
  // lockfiles, .github/**, shared and build config, the filter itself.
  it.each([
    ["package.json"],
    ["package-lock.json"],
    ["tsconfig.json"],
    ["esbuild.config.mjs"],
    ["vitest.config.ts"],
    [".github/workflows/ci.yml"],
    [".github/pull_request_template.md"],
    ["scripts/ci-changes.mjs"],
    ["tests/ci-changes.spec.ts"],
    ["src/worker.ts"],
    ["migrations/001_init.sql"],
    ["packages/lane-capacity/src/contract.ts"],
    [".gitleaks.toml"],
    [".gitignore"],
    ["LICENSE"],
  ])("%s runs everything", (file) => {
    expect(ci.classify([file]).code).toBe(true);
  });

  // These docs are read by tests or by the pack step. Skipping verify on a
  // README edit would let a docs-vs-code drift test fail on main instead.
  it.each([
    ["README.md"],
    ["CHANGELOG.md"],
    ["docs/OPERATIONS.md"],
    ["docs/PROCESS.md"],
    ["docs/contracts/compatible-upstream-v1.md"],
    ["docs/operator/tog-2922-pace-prerequisites.json"],
    ["docs/operator/pacer-shadow-diff-report.md"],
    ["docs/branch-ruleset.main.json"],
  ])("%s is read by a test or the pack step, so it runs everything", (file) => {
    expect(ci.classify([file]).code).toBe(true);
  });

  it("one code file among many docs runs everything", () => {
    expect(ci.classify(["AGENTS.md", "docs/decisions/0001-x.md", "src/index.ts"]).code).toBe(true);
  });

  it("an empty or blank diff runs everything", () => {
    expect(ci.classify([]).code).toBe(true);
    expect(ci.classify(["", "  "]).code).toBe(true);
  });

  it("does not match a lookalike prefix", () => {
    expect(ci.classify(["docs/decisions-extra/x.sh"]).code).toBe(true);
    expect(ci.classify(["docs/securityx/x.md"]).code).toBe(true);
    expect(ci.classify(["notes/AGENTS.md"]).code).toBe(true);
    expect(ci.classify(["docs/decisions/../../src/worker.ts"]).code).toBe(true);
  });
});

describe("detect: every non-skip route fails safe", () => {
  const git = (files: string) => (args: string[]) => (args[0] === "merge-base" ? "abc123\n" : files);

  it.each(["push", "schedule", "workflow_dispatch", "merge_group", undefined])(
    "%s event runs everything",
    (event) => {
      expect(ci.detect({ EVENT_NAME: event, BASE_SHA: "a", HEAD_SHA: "b" }, git("AGENTS.md\n")).code).toBe(true);
    },
  );

  it("a pull request without shas runs everything", () => {
    expect(ci.detect({ EVENT_NAME: "pull_request" }, git("AGENTS.md\n")).code).toBe(true);
  });

  it("a failing git call runs everything", () => {
    const boom = () => {
      throw new Error("fatal: Not a valid object name");
    };
    const out = ci.detect({ EVENT_NAME: "pull_request", BASE_SHA: "a", HEAD_SHA: "b" }, boom);
    expect(out.code).toBe(true);
    expect(out.reason).toMatch(/full run/);
  });

  it("diffs against the merge base, not the base tip", () => {
    const calls: string[][] = [];
    ci.detect({ EVENT_NAME: "pull_request", BASE_SHA: "base", HEAD_SHA: "head" }, (args) => {
      calls.push(args);
      return args[0] === "merge-base" ? "mb\n" : "AGENTS.md\n";
    });
    expect(calls).toEqual([
      ["merge-base", "base", "head"],
      ["diff", "--name-only", "--no-renames", "mb", "head"],
    ]);
  });

  it("a docs-only pull request is the only route to code=false", () => {
    expect(
      ci.detect({ EVENT_NAME: "pull_request", BASE_SHA: "a", HEAD_SHA: "b" }, git("AGENTS.md\ndocs/security/x.md\n")).code,
    ).toBe(false);
  });
});

describe("the script, run for real against a git history", () => {
  function run(files: Record<string, string>, event = "pull_request") {
    const dir = mkdtempSync(join(tmpdir(), "ci-changes-"));
    const sh = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
    try {
      sh("init", "-q", "-b", "main");
      sh("config", "user.email", "ci@example.invalid");
      sh("config", "user.name", "ci");
      writeFileSync(join(dir, "README.md"), "base\n");
      sh("add", ".");
      sh("commit", "-qm", "base");
      const base = sh("rev-parse", "HEAD").trim();
      sh("checkout", "-q", "-b", "pr");
      sh("checkout", "-q", "main");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "moved-on.ts"), "export {};\n");
      sh("add", ".");
      sh("commit", "-qm", "main moves on");
      const mainTip = sh("rev-parse", "HEAD").trim();
      sh("checkout", "-q", "pr");
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), body);
      }
      sh("add", ".");
      sh("commit", "-qm", "pr");
      const head = sh("rev-parse", "HEAD").trim();
      const out = join(dir, "..", `gh-output-${base.slice(0, 8)}`);
      writeFileSync(out, "");
      const env = { ...process.env, EVENT_NAME: event, BASE_SHA: mainTip, HEAD_SHA: head, GITHUB_OUTPUT: out };
      execFileSync("node", [script], { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
      const written = readFileSync(out, "utf8");
      rmSync(out);
      return written.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a docs-only pull request writes code=false, whatever main did since", () => {
    // src/moved-on.ts landed on main after the branch point and BASE_SHA is the
    // new main tip, as on GitHub. Diffing the base tip against head would list
    // it as part of this PR; the merge-base diff keeps it out.
    expect(run({ "docs/decisions/0001-x.md": "x\n" })).toBe("code=false");
  });

  it("moving a code file into the docs allow-list is still a code change", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-changes-rename-"));
    const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
    try {
      sh("init", "-q", "-b", "main");
      sh("config", "user.email", "ci@example.invalid");
      sh("config", "user.name", "ci");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "gate.ts"), "export const gate = () => true;\n");
      sh("add", ".");
      sh("commit", "-qm", "base");
      const base = sh("rev-parse", "HEAD").trim();
      mkdirSync(join(dir, "docs", "decisions"), { recursive: true });
      sh("mv", "src/gate.ts", "docs/decisions/gate.md");
      sh("commit", "-qam", "rename");
      const head = sh("rev-parse", "HEAD").trim();
      const out = join(dir, "gh-output");
      writeFileSync(out, "");
      const env = { ...process.env, EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: out };
      execFileSync("node", [script], { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
      expect(readFileSync(out, "utf8").trim()).toBe("code=true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a dependency manifest change writes code=true", () => {
    expect(run({ "package.json": "{}\n" })).toBe("code=true");
  });

  it("a workflow change writes code=true", () => {
    expect(run({ ".github/workflows/ci.yml": "name: x\n" })).toBe("code=true");
  });

  it("a push event writes code=true even for a docs-only diff", () => {
    expect(run({ "AGENTS.md": "x\n" }, "push")).toBe("code=true");
  });
});

describe("the allow-list stays honest", () => {
  // A listed doc must not be read by any test, script, config or build step, or
  // a docs-only PR would skip the job that fails when that doc drifts. This is a
  // best-effort textual guard: it flags any non-comment line in the code that
  // runs in CI which names a listed file or directory. It cannot see a read that
  // builds its path at runtime, which is why the list is kept short.
  const LISTED = ["CONTRIBUTING.md", "AGENTS.md", "docs/decisions", "docs/security"];
  const SELF = new Set(["scripts/ci-changes.mjs", "tests/ci-changes.spec.ts"]);
  const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".venv", "__pycache__"]);

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) yield* walk(rel);
      } else if (/\.(m?[jt]s|py|sh|json|ya?ml)$/.test(entry.name)) {
        yield rel;
      }
    }
  }

  it("no executable file reads a listed doc", () => {
    const files = [
      ...["tests", "scripts", "packages", "src", ".github/scripts"].flatMap((d) => [...walk(d)]),
      "esbuild.config.mjs",
      "vitest.config.ts",
      "tsconfig.json",
      "package.json",
    ].filter((f) => !SELF.has(f));
    expect(files.length, "the walk found nothing to scan").toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(root, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#")) return;
          for (const needle of LISTED) if (line.includes(needle)) hits.push(`${f}:${i + 1} names ${needle}`);
        });
    }
    expect(hits, "take the doc off DOCS_ONLY in scripts/ci-changes.mjs").toEqual([]);
  });
});

describe("ci.yml wiring", () => {
  const job = (name: string): string => {
    const m = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|(?![\\s\\S]))`, "m"));
    expect(m, `ci.yml has no \`${name}\` job`).not.toBeNull();
    return m?.[1] ?? "";
  };

  it("gates at job level and never with a workflow-level paths filter", () => {
    // A workflow-level `paths:` on pull_request stops the workflow reporting at
    // all on a docs-only PR, and the required check waits forever.
    const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(on).not.toMatch(/^\s*paths(-ignore)?:/m);
    expect(job("verify")).toMatch(/needs: \[changes\]/);
    expect(job("verify")).toMatch(/if: needs\.changes\.outputs\.code == 'true'/);
  });

  it("runs the full suite on push to main and nightly", () => {
    const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(on).toMatch(/push:\s*\n\s*branches: \["main"\]/);
    expect(on).toMatch(/schedule:\s*\n\s*- cron: "/);
  });

  it("change detection is native git — no third-party action", () => {
    const changes = job("changes");
    expect(changes).toContain("fetch-depth: 0");
    expect(changes).toContain("node scripts/ci-changes.mjs");
    const uses = [...changes.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses).toEqual(["actions/checkout@v4"]);
  });

  it("secret scan always runs", () => {
    expect(job("secret-scan")).not.toMatch(/^\s+if:/m);
    expect(job("secret-scan")).not.toMatch(/needs:/);
  });

  it("ci-ok runs always and needs every other job", () => {
    const ciOk = job("ci-ok");
    expect(ciOk).toMatch(/^    if: always\(\)/m);
    const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
    const jobs = [...jobsSection.matchAll(/^  ([a-z][a-z-]*):\n/gm)].map((m) => m[1]).filter((j) => j !== "ci-ok");
    const needs = (ciOk.match(/needs: \[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => s.trim());
    expect(needs.sort()).toEqual(jobs.sort());
  });

  it("ci-ok refuses a skip it cannot explain", () => {
    const ciOk = job("ci-ok");
    // verify may be skipped only when change detection said code=false.
    expect(ciOk).toMatch(/\[ "\$VERIFY" = "skipped" \] && \[ "\$CODE" = "false" \]/);
    expect(ciOk).toMatch(/\[ "\$CHANGES" = "success" \]/);
    expect(ciOk).toMatch(/\[ "\$SECRET_SCAN" = "success" \]/);
  });

  it("the merged job keeps its name so existing references still resolve", () => {
    expect(job("verify")).toContain("name: typecheck, test, build, package, version");
  });
});
