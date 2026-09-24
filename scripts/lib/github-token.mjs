import { execFileSync } from "node:child_process";

/**
 * Let git resolve its own helpers, including `!` shell functions, quoted
 * arguments, helper ordering and empty-value resets (TOG-4372). Reimplementing
 * that protocol by space-splitting a helper breaks otherwise working fetches.
 * Never prompt or echo helper diagnostics: absence is a release-gate failure,
 * and stderr may contain credentials. `fill` does not approve/store a token.
 */
export function githubToken() {
  try {
    const out = execFileSync("git", ["-c", "core.askPass=", "-c", "credential.interactive=false", "credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 15_000,
    });
    const line = out.split("\n").find((l) => l.startsWith("password="));
    return line?.slice("password=".length) || null;
  } catch {
    return null;
  }
}
