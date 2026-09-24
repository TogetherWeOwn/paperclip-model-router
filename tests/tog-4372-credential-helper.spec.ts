/** TOG-4372: real git plumbing, isolated config and synthetic credentials only. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/lib/github-token.mjs", import.meta.url).href;
let scratch: string;
let env: NodeJS.ProcessEnv;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: scratch, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function helper(body: string, key = "credential.https://github.com.helper") {
  git("config", "--add", key, body);
}

function resolveToken() {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { githubToken } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(githubToken()));
  `], { cwd: scratch, env, encoding: "utf8", timeout: 20_000 });
  expect(Boolean(result.error), "credential subprocess must finish").toBe(false);
  expect(result.status).toBe(0);
  expect(result.stderr.length, "credential subprocess must not print diagnostics").toBe(0);
  const value = JSON.parse(result.stdout) as string | null;
  // Never let an unexpected live credential appear in assertion diagnostics.
  const fixtures = ["synthetic-token", "quoted-token", "executable-token", "first-token", "last-token", "fallback-token", "partial-token", "discarded-token", "reset-token", "generic-token", "must-not-return"];
  if (value !== null && !fixtures.includes(value)) throw new Error("Non-fixture credential returned; refusing to print it");
  return value;
}

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "tog4372-"));
  // These are local-only fixture commands, never remote GitHub operations. Do
  // not inherit credentials or the broker launcher that injects live helpers.
  const launcher = process.env.PAPERCLIP_GITHUB_LAUNCHER_DIR;
  const path = (process.env.PATH || "").split(delimiter)
    .filter((entry) => !launcher || resolve(entry) !== resolve(launcher)).join(delimiter);
  env = { PATH: path, SystemRoot: process.env.SystemRoot };
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(scratch, "global.gitconfig");
  env.HOME = scratch;
  env.XDG_CONFIG_HOME = scratch;
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  git("init", "--quiet");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("release-pin GitHub credential resolution", () => {
  it("runs inline shell functions with get and the GitHub credential request", () => {
    helper(`!f() {
      [ "$#" = 1 ] && [ "$1" = get ] || exit 1
      request=$(cat)
      [ "$request" = "$(printf 'protocol=https\\nhost=github.com')" ] || exit 1
      printf 'username=test-user\\npassword=synthetic-token\\n'
    }; f`);
    expect(resolveToken()).toBe("synthetic-token");
  });

  it("preserves quoted executable paths and arguments containing spaces", () => {
    const path = join(scratch, "helper with spaces.sh");
    writeFileSync(path, `#!/bin/sh
[ "$1" = 'two words' ] && [ "$2" = get ] || exit 1
printf 'username=test-user\\npassword=quoted-token\\n'
`, { mode: 0o700 });
    helper(`!"${path}" 'two words'`);
    expect(resolveToken()).toBe("quoted-token");
  });

  it("supports non-shell absolute executable helpers", () => {
    const path = join(scratch, "credential-helper");
    writeFileSync(path, "#!/bin/sh\n[ \"$1\" = get ] || exit 1\nprintf 'username=test-user\\npassword=executable-token\\n'\n", { mode: 0o700 });
    helper(path);
    expect(resolveToken()).toBe("executable-token");
  });

  it("uses the first complete credential, not the last configured helper", () => {
    helper("!f() { printf 'username=test-user\\npassword=first-token\\n'; }; f");
    helper("!f() { printf 'username=test-user\\npassword=last-token\\n'; }; f");
    expect(resolveToken()).toBe("first-token");
  });

  it("falls through helpers that decline or fail", () => {
    helper("!f() { exit 1; }; f");
    helper("!f() { :; }; f");
    helper("!f() { printf 'username=test-user\\npassword=fallback-token\\n'; }; f");
    expect(resolveToken()).toBe("fallback-token");
  });

  it("accumulates partial credentials across helpers", () => {
    helper("!f() { printf 'username=test-user\\n'; }; f");
    helper("!f() { printf 'password=partial-token\\n'; }; f");
    expect(resolveToken()).toBe("partial-token");
  });

  it("honors an empty helper reset across generic and URL-specific config", () => {
    helper("!f() { printf 'username=test-user\\npassword=discarded-token\\n'; }; f", "credential.helper");
    helper("");
    helper("!f() { printf 'username=test-user\\npassword=reset-token\\n'; }; f");
    expect(resolveToken()).toBe("reset-token");
  });

  it("resolves generic helpers without a GitHub-specific entry", () => {
    helper("!f() { printf 'username=test-user\\npassword=generic-token\\n'; }; f", "credential.helper");
    expect(resolveToken()).toBe("generic-token");
  });

  it("honors quit instead of falling through to another helper", () => {
    helper("!f() { printf 'quit=true\\n'; }; f");
    helper("!f() { printf 'username=test-user\\npassword=must-not-return\\n'; }; f");
    expect(resolveToken()).toBeNull();
  });

  it("returns null without prompting through any askpass channel", () => {
    const askpass = join(scratch, "askpass.sh");
    const marker = join(scratch, "prompted");
    writeFileSync(askpass, `#!/bin/sh\nprintf 'called' > '${marker}'\nprintf 'unexpected\\n'\n`, { mode: 0o700 });
    env.GIT_ASKPASS = askpass;
    env.SSH_ASKPASS = askpass;
    env.GIT_TERMINAL_PROMPT = "1";
    git("config", "core.askPass", askpass);
    expect(resolveToken()).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it("does not forward helper diagnostics to stderr", () => {
    helper("!f() { printf 'synthetic-sensitive-diagnostic\\n' >&2; exit 1; }; f");
    expect(resolveToken()).toBeNull();
  });

  it("treats an empty password as a missing token", () => {
    helper("!f() { printf 'username=test-user\\npassword=\\n'; }; f");
    expect(resolveToken()).toBeNull();
  });
});
