import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function localDatabaseUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const envFile = await readFile(path.join(root, ".env.local"), "utf8").catch(() => "");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("SUPABASE_DB_URL=")) continue;
    const value = trimmed.slice("SUPABASE_DB_URL=".length).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return "";
}

const databaseUrl = await localDatabaseUrl();
if (!databaseUrl) throw new Error("Set SUPABASE_DB_URL or add it to .env.local.");

const migrationsDirectory = path.join(root, "supabase", "migrations");
const migrationNames = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{12,14}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (migrationNames.length === 0) throw new Error("No versioned Supabase migrations were found.");

const migrations = await Promise.all(migrationNames.map(async (name) => ({
  name,
  sql: await readFile(path.join(migrationsDirectory, name), "utf8")
})));
const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  await client.query("begin");
  for (const migration of migrations) {
    console.log(`Applying ${migration.name}...`);
    await client.query(migration.sql);
  }
  await client.query("commit");
  console.log(`Applied ${migrations.length} migrations in ascending order.`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
