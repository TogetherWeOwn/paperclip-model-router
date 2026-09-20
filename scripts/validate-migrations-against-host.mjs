#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import manifest from "../dist/manifest.js";
import { decisionInsertSql, decisionPruneSql } from "../dist/decision-records.js";
import { describePolicy, probePolicy } from "./lib/host-probes.mjs";

// Mirror verify:host's TOG-1070 policy so the two host probes cannot disagree
// about whether a checkout is present. This validator needs the host's compiled
// `plugin-database.js` AND its embedded PostgreSQL, so when no checkout is
// reachable it can only be SKIPPED, never mirrored — but it must not CRASH. It
// used to force `PAPERCLIP_HOST=/app` in the npm script and read the source
// unconditionally, so on any runner without a host mounted at /app (a CI or
// release runner that drew a host-less machine) it died with ENOENT instead of
// skipping, which is how the v0.5.0 release's `npm run verify` failed while the
// same commit's CI went green on a host-equipped runner (TOG-3419).
const policy = probePolicy();
console.log(describePolicy(policy));
if (!policy.host.present) {
  if (policy.strict) {
    console.error(
      `FAIL  migration validation\n      a host was requested (${policy.host.from ?? "PAPERCLIP_HOST"}) but ${policy.host.root ?? "/app"}/server/dist is missing — build the host checkout first`,
    );
    process.exit(1);
  }
  console.log(
    "SKIP  migration validation\n      no host checkout reachable — this run is NOT the pre-tag migration gate (run PAPERCLIP_HOST=/app npm run verify:migrations from a checkout)",
  );
  process.exit(0);
}
const hostRoot = policy.host.root;
const sourcePath = join(resolve(hostRoot), "server", "dist", "services", "plugin-database.js");
let source = readFileSync(sourcePath, "utf8")
  .replace(/^import .*?from "drizzle-orm";\n/gm, "")
  .replace(/^import \{[\s\S]*?\} from "@paperclipai\/db";\n/m, "")
  .replace(/^import type .*?;\n/gm, "")
  .replace(/export function pluginDatabaseService[\s\S]*$/m, "");
source = 'import { createHash } from "node:crypto";\n' + source;
const modulePath = join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.cwd(), "plugin-database-validator.mjs");
writeFileSync(modulePath, source);
const database = await import(`${pathToFileURL(modulePath).href}?sha=${createHash("sha256").update(source).digest("hex")}`);

const namespace = database.derivePluginDatabaseNamespace(
  manifest.id,
  manifest.database.namespaceSlug,
);
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const files = readdirSync(join(root, manifest.database.migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrations = files.map((file) => readFileSync(join(root, manifest.database.migrationsDir, file), "utf8"));
let statements = 0;
for (const migration of migrations) {
  for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) {
    database.validatePluginMigrationStatement(statement, namespace, manifest.database.coreReadTables ?? []);
    statements += 1;
  }
}

const insertSql = decisionInsertSql(namespace);
const pruneSql = decisionPruneSql(namespace);
database.validatePluginRuntimeExecute(insertSql, namespace);
database.validatePluginRuntimeExecute(pruneSql, namespace);

const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.cwd();
const dataDir = mkdtempSync(join(scratchRoot, "decision-records-postgres-"));
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.unref();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("failed to allocate PostgreSQL test port")));
      return;
    }
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});
const { default: EmbeddedPostgres } = await import(
  pathToFileURL(join(resolve(hostRoot), "packages", "db", "node_modules", "embedded-postgres", "dist", "index.js")).href
);
const postgresModule = await import(
  pathToFileURL(join(resolve(hostRoot), "packages", "db", "node_modules", "postgres", "src", "index.js")).href
);
const instance = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "paperclip",
  password: "paperclip",
  port,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog() {},
  onError() {},
});
let sql;
try {
  await instance.initialise();
  await instance.start();
  await instance.createDatabase("router_validation");
  sql = postgresModule.default(`postgres://paperclip:paperclip@127.0.0.1:${port}/router_validation`, { max: 1 });
  await sql.unsafe(`CREATE SCHEMA ${namespace}`);
  for (const migration of migrations) await sql.unsafe(migration);

  const now = new Date("2026-09-06T12:00:00.000Z");
  const base = [
    "11111111-1111-4111-8111-111111111111", "company-a", now.toISOString(), "inside",
    "agent-a", "run-a", "issue-a", "implementation", "selected", "model-a", false,
    "openai-chat-completions", "completed", null, null, 10, 1, 1, "end-turn", null,
    "disabled", "not-evaluated", null, null, "not-evaluated", null, false, null,
  ];
  await sql.unsafe(insertSql, base);
  await sql.unsafe(insertSql, base);
  await sql.unsafe(insertSql, ["22222222-2222-4222-8222-222222222222", base[1], new Date(now.getTime() - 90 * 86_400_000 - 1).toISOString(), "outside", ...base.slice(4)]);
  await sql.unsafe(pruneSql, [now.toISOString(), 90]);
  const rows = await sql.unsafe(`SELECT request_id FROM ${namespace}.decision_records ORDER BY request_id`);
  if (rows.length !== 1 || rows[0]?.request_id !== "inside") {
    throw new Error(`runtime SQL retention rehearsal failed: ${JSON.stringify(rows)}`);
  }
} finally {
  if (sql) await sql.end({ timeout: 1 }).catch(() => {});
  await instance.stop().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`PASS ${files.length} migration file(s), ${statements} statement(s), production insert/prune SQL, namespace=${namespace}`);
