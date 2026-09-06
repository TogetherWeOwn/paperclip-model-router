#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import manifest from "../dist/manifest.js";

const hostRoot = process.env.PAPERCLIP_HOST;
if (!hostRoot) throw new Error("PAPERCLIP_HOST is required");
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
let statements = 0;
for (const file of files) {
  const migration = readFileSync(join(root, manifest.database.migrationsDir, file), "utf8");
  for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) {
    database.validatePluginMigrationStatement(statement, namespace, manifest.database.coreReadTables ?? []);
    statements += 1;
  }
}
database.validatePluginRuntimeExecute(
  `INSERT INTO ${namespace}.decision_records (id) VALUES ($1)`,
  namespace,
);
database.validatePluginRuntimeExecute(
  `DELETE FROM ${namespace}.decision_records WHERE recorded_at < now()`,
  namespace,
);
console.log(`PASS ${files.length} migration file(s), ${statements} statement(s), namespace=${namespace}`);
