#!/usr/bin/env node
// Report-only sweep: list nested project checkouts that the host cannot adopt.
//
// Background: the run setup materializes registered project workspaces as nested
// checkouts under `<workspace>/.paperclip-repositories/<name>-<hash>/`. The sync
// layer's `tar --exclude .git` matches at every depth, so a nested checkout that
// is reconstituted from sync data can end up as plain files with no `.git`. Run
// setup then fails fatally on the exact head it would otherwise use, and every
// continuation inheriting that workspace fails identically until the bad snapshot
// is moved aside and a clean checkout is re-provisioned.
//
// This script REPORTS ONLY. It never writes, moves, or deletes anything.
// It uses filesystem reads plus a read-only `du` subprocess. Exit code is 1 if a
// requested root or workspace cannot be scanned; hits are reported on stdout,
// diagnostics on stderr.
//
// Usage:
//   node nested-non-git-sweep.mjs <worktree-root> [<worktree-root> ...]
//
// Each root's immediate children are treated as workspaces. A hit line looks like:
//   HIT <workspace-path> <.paperclip-repositories/<name>> <bytes> <mtime-iso> <adoption-status>
//
// A nested checkout is adoptable only when `.git` resolves to a directory.
// A `.git` file may still point to valid Git metadata, but the host's directory-only
// check rejects it as `non-directory-git-entry`. Missing entries are `missing`,
// dangling symlinks are `dead-gitdir`, and other stat failures are `unverifiable-gitdir`.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const NESTED_ROOT = ".paperclip-repositories";

async function duBytes(target) {
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

async function gitdirAdoptability(nestedDir) {
  const dotGit = path.join(nestedDir, ".git");
  try {
    await fs.lstat(dotGit);
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "unverifiable-gitdir";
  }

  try {
    const stat = await fs.stat(dotGit);
    return stat.isDirectory() ? "adoptable" : "non-directory-git-entry";
  } catch (error) {
    return error.code === "ENOENT" ? "dead-gitdir" : "unverifiable-gitdir";
  }
}

async function lstatOrNull(target, onScanError) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    onScanError(`cannot inspect ${target}`, error);
    return null;
  }
}

async function scanWorkspace(workspacePath, onScanError) {
  const hits = [];
  const root = path.join(workspacePath, NESTED_ROOT);
  const rootStat = await lstatOrNull(root, onScanError);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return hits;
  let entries = [];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    onScanError(`cannot list ${root}`, error);
    return hits;
  }
  for (const name of entries.sort()) {
    if (name.includes(".clone-")) continue;
    const nestedDir = path.join(root, name);
    const stat = await lstatOrNull(nestedDir, onScanError);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
    const adoptionStatus = await gitdirAdoptability(nestedDir);
    if (adoptionStatus === "adoptable") continue;
    const bytes = await duBytes(nestedDir);
    const mtime = stat.mtime.toISOString();
    hits.push({ workspacePath, relative: `${NESTED_ROOT}/${name}`, bytes, mtime, adoptionStatus });
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
  async function candidates(dir, onScanError) {
    // Workspaces may sit one level down (worktrees/<project>/<branch>), so
    // collect both children and grandchildren directory paths. Read-only.
    const found = [];
    let children = [];
    try {
      children = await fs.readdir(dir);
    } catch (error) {
      onScanError(`cannot list root ${dir}`, error);
      return found;
    }
    for (const child of children.sort()) {
      const childPath = path.join(dir, child);
      const stat = await lstatOrNull(childPath, onScanError);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
      found.push(childPath);
      let grand = [];
      try {
        grand = await fs.readdir(childPath);
      } catch (error) {
        onScanError(`cannot list child ${childPath}`, error);
        continue;
      }
      for (const name of grand.sort()) {
        const grandPath = path.join(childPath, name);
        const gstat = await lstatOrNull(grandPath, onScanError);
        if (!gstat || !gstat.isDirectory() || gstat.isSymbolicLink()) continue;
        found.push(grandPath);
      }
    }
    return found;
  }
  let scanErrors = 0;
  const onScanError = (message, error) => {
    scanErrors += 1;
    console.error(`WARN ${message}: ${error.code ?? error.message}`);
  };
  for (const root of roots) {
    for (const workspacePath of await candidates(root, onScanError)) {
      workspaces += 1;
      for (const hit of await scanWorkspace(workspacePath, onScanError)) {
        hits += 1;
        const size = hit.bytes === null ? "size-unknown" : `${hit.bytes}B`;
        console.log(`HIT ${hit.workspacePath} ${hit.relative} ${size} ${hit.mtime} ${hit.adoptionStatus}`);
      }
    }
  }
  console.log(`SUMMARY workspaces=${workspaces} nested-not-adoptable=${hits} scan-errors=${scanErrors}`);
  if (scanErrors > 0) process.exitCode = 1;
}

await main();
