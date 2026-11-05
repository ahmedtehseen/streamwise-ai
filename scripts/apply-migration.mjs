import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = await readFile(path.join(root, ".env.local"), "utf8");

let dbUrl = "";
for (const line of envFile.split("\n")) {
  const trimmed = line.trim();
  if (trimmed.startsWith("SUPABASE_DB_URL=")) {
    dbUrl = trimmed.slice("SUPABASE_DB_URL=".length).trim();
    if ((dbUrl.startsWith('"') && dbUrl.endsWith('"')) || (dbUrl.startsWith("'") && dbUrl.endsWith("'"))) {
      dbUrl = dbUrl.slice(1, -1);
    }
    break;
  }
}

if (!dbUrl) {
  console.error("Error: SUPABASE_DB_URL not found in .env.local");
  process.exit(1);
}

const migrationPath = path.join(root, "supabase", "migrations", "202611040001_multi_format_and_hybrid_search.sql");
const sql = await readFile(migrationPath, "utf8");

console.log("Connecting to Supabase PostgreSQL database...");
const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

try {
  await client.connect();
  console.log("Connected successfully. Applying migration 202611040001_multi_format_and_hybrid_search.sql...");

  await client.query("BEGIN;");
  await client.query(sql);
  await client.query("COMMIT;");

  console.log("Migration applied successfully!");
} catch (err) {
  console.error("Migration failed:", err);
  try {
    await client.query("ROLLBACK;");
  } catch {}
  process.exit(1);
} finally {
  await client.end();
}

