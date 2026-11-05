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

  const { rows: existingRelationRows } = await client.query(`
    select array_remove(array[
      case when to_regclass('public.knowledge_bases') is not null then 'knowledge_bases' end,
      case when to_regclass('public.project_documents') is not null then 'project_documents' end,
      case when to_regclass('public.document_chunks') is not null then 'document_chunks' end,
      case when to_regclass('public.public_allowance_buckets') is not null then 'public_allowance_buckets' end,
      case when to_regclass('public.answer_flags') is not null then 'answer_flags' end
    ], null) as relations
  `);
  const existingRelations = existingRelationRows[0]?.relations ?? [];
  if (existingRelations.length > 0) {
    throw new Error(
      `Refusing to replay bootstrap migrations because application tables already exist: ${existingRelations.join(", ")}. Apply only the missing migration files with the Supabase SQL Editor.`
    );
  }

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
