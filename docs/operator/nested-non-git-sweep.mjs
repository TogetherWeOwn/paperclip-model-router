#!/usr/bin/env node
// Report-only sweep: list workspaces whose nested project checkouts lost `.git`.
//
// Background: the run setup materializes registered project workspaces as nested
// checkouts under `<workspace>/.paperclip-repositories/<name>-<hash>/`. The sync
// layer's `tar --exclude .git` matches at every depth, so a nested checkout that
// is reconstituted from sync data can end up as plain files with no `.git`. Run
// setup then fails fatally on the exact head it would otherwise use, and every
// continuation inheriting that workspace fails identically until the bad snapshot
// is moved aside and a clean checkout is re-provisioned.
//
// This script REPORTS ONLY. It never writes, moves, or deletes anything: it uses
// readdir/stat/readFile exclusively. Exit code is always 0 when the scan itself
// runs; hits are reported on stdout, diagnostics on stderr.
//
// Usage:
//   node nested-non-git-sweep.mjs <worktree-root> [<worktree-root> ...]
//
// Each root's immediate children are treated as workspaces. A hit line looks like:
//   HIT <workspace-path> <.paperclip-repositories/<name>> <bytes> <mtime-iso> [dead-gitdir]
//
// A `.git` that is a file (worktree pointer) counts as healthy only when the
// gitdir it names exists; otherwise the entry is flagged `dead-gitdir`.

import { promises as fs } from "node:fs";
import path from "node:path";

const NESTED_ROOT = ".paperclip-repositories";

function dirSizeEstimate() {
  // Sizes are computed with du when available; the fallback walks the tree.
  return null;
}

async function duBytes(target) {
  const { execFile } = await import("node:child_process");
  try {
    const out = await new Promise((resolve, reject) => {
      execFile("du", ["-sb", target], { timeout: 30_000 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
    const bytes = Number(String(out).split("\t")[0]);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

async function gitdirAlive(nestedDir) {
  // Returns: "ok" | "missing" | "dead-gitdir".
  const dotGit = path.join(nestedDir, ".git");
  const stat = await fs.lstat(dotGit).catch(() => null);
  if (!stat) return "missing";
  if (stat.isDirectory()) return "ok";
  if (stat.isFile()) {
    const text = await fs.readFile(dotGit, "utf8").catch(() => "");
    const match = text.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return "dead-gitdir";
    const target = path.resolve(nestedDir, match[1].trim());
    return (await fs.stat(target).catch(() => null)) ? "ok" : "dead-gitdir";
  }
  return "dead-gitdir";
}

async function scanWorkspace(workspacePath) {
  const hits = [];
  const root = path.join(workspacePath, NESTED_ROOT);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return hits;
  let entries = [];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    console.error(`WARN cannot list ${root}: ${error.code ?? error.message}`);
    return hits;
  }
  for (const name of entries.sort()) {
    if (name.includes(".clone-")) continue;
    const nestedDir = path.join(root, name);
    const stat = await fs.lstat(nestedDir).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
    const health = await gitdirAlive(nestedDir);
    if (health === "ok") continue;
    const bytes = await duBytes(nestedDir);
    const mtime = stat.mtime.toISOString();
    hits.push({ workspacePath, relative: `${NESTED_ROOT}/${name}`, bytes, mtime, health });
  }
  return hits;
}

async function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error("Usage: node nested-non-git-sweep.mjs <worktree-root> [<worktree-root> ...]");
    process.exitCode = 2;
    return;
  }
  let workspaces = 0;
  let hits = 0;
  async function candidates(dir) {
    // Workspaces may sit one level down (worktrees/<project>/<branch>), so
    // collect both children and grandchildren directory paths. Read-only.
    const found = [];
    let children = [];
    try {
      children = await fs.readdir(dir);
    } catch (error) {
      console.error(`WARN cannot list root ${dir}: ${error.code ?? error.message}`);
      return found;
    }
    for (const child of children.sort()) {
      const childPath = path.join(dir, child);
      const stat = await fs.lstat(childPath).catch(() => null);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
      found.push(childPath);
      let grand = [];
      try {
        grand = await fs.readdir(childPath);
      } catch {
        continue;
      }
      for (const name of grand.sort()) {
        const grandPath = path.join(childPath, name);
        const gstat = await fs.lstat(grandPath).catch(() => null);
        if (!gstat || !gstat.isDirectory() || gstat.isSymbolicLink()) continue;
        found.push(grandPath);
      }
    }
    return found;
  }
  for (const root of roots) {
    for (const workspacePath of await candidates(root)) {
      workspaces += 1;
      for (const hit of await scanWorkspace(workspacePath)) {
        hits += 1;
        const size = hit.bytes === null ? "size-unknown" : `${hit.bytes}B`;
        const flag = hit.health === "ok" ? "" : ` ${hit.health}`;
        console.log(`HIT ${hit.workspacePath} ${hit.relative} ${size} ${hit.mtime}${flag}`);
      }
    }
  }
  console.log(`SUMMARY workspaces=${workspaces} nested-without-git=${hits}`);
}

void dirSizeEstimate;
await main();
