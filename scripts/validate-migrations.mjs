import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(root, "supabase", "migrations");
const names = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();

if (names.length === 0) throw new Error("No Supabase migrations were found.");

const versions = names.map((name) => {
  const match = /^(\d{12,14})_[a-z0-9_]+\.sql$/.exec(name);
  if (!match) throw new Error(`Migration filename is not versioned correctly: ${name}`);
  return match[1];
});

if (new Set(versions).size !== versions.length) {
  throw new Error("Supabase migration versions must be unique.");
}

const migrations = await Promise.all(names.map(async (name) => ({
  name,
  sql: await readFile(path.join(migrationsDirectory, name), "utf8")
})));
const schema = migrations.map(({ sql }) => sql).join("\n").toLowerCase();

const requiredFragments = [
  "create extension if not exists vector",
  "extensions.vector(768)",
  "embedding_model = 'gemini-embedding-2'",
  "embedding_dimension = 768",
  "unique (knowledge_base_id, content_fingerprint)",
  "references public.project_documents(id) on delete cascade",
  ">= 20",
  "where document.status = 'ready'",
  "limit least(greatest(p_match_count, 1), 5)",
  "alter table public.knowledge_bases enable row level security",
  "alter table public.project_documents enable row level security",
  "alter table public.document_chunks enable row level security",
  "create or replace function public.begin_project_document_indexing",
  "create or replace function public.complete_project_document_indexing",
  "create or replace function public.fail_project_document_indexing",
  "create or replace function public.retry_project_document_indexing",
  "create or replace function public.match_ready_document_chunks",
  "create or replace function public.match_ready_document_chunks_hybrid",
  "create or replace function public.match_ready_document_chunks_full_text",
  "revoke all on function public.begin_project_document_indexing",
  "revoke all on function public.complete_project_document_indexing",
  "revoke all on function public.fail_project_document_indexing",
  "revoke all on function public.retry_project_document_indexing",
  "revoke all on function public.match_ready_document_chunks",
  "grant execute on function public.begin_project_document_indexing",
  "grant execute on function public.complete_project_document_indexing",
  "grant execute on function public.fail_project_document_indexing",
  "grant execute on function public.retry_project_document_indexing",
  "grant execute on function public.match_ready_document_chunks",
  "revoke all on function public.match_ready_document_chunks_full_text",
  "grant execute on function public.match_ready_document_chunks_full_text",
  "create table public.public_allowance_buckets",
  "alter table public.public_allowance_buckets enable row level security",
  "create or replace function public.admit_public_action",
  "pg_advisory_xact_lock",
  "'america/los_angeles'",
  "v_visitor_minute >= 3",
  "v_global_minute >= 15",
  "v_visitor_day >= 10",
  "v_global_day >= 50",
  "revoke all on function public.admit_public_action",
  "grant execute on function public.admit_public_action",
  "create table public.answer_flags",
  "unique (response_fingerprint)",
  "char_length(visitor_note) <= 500",
  "alter table public.answer_flags enable row level security",
  "create or replace function public.submit_answer_flag",
  "create or replace function public.review_answer_flag",
  "revoke all on function public.submit_answer_flag",
  "grant execute on function public.submit_answer_flag",
  "revoke all on function public.review_answer_flag",
  "grant execute on function public.review_answer_flag",
  "replaces_document_id uuid references public.project_documents(id) on delete cascade",
  "create unique index project_documents_one_pending_replacement",
  "where replaces_document_id is not null",
  "count(*) from public.project_documents where knowledge_base_id = requested_knowledge_base_id and replaces_document_id is null",
  "create or replace function public.begin_project_document_replacement",
  "create or replace function public.retry_project_document_replacement",
  "create or replace function public.discard_project_document_replacement",
  "delete from public.project_documents where id = superseded_document_id",
  "name = 'portfolio owner knowledge base'"
];

for (const fragment of requiredFragments) {
  if (!schema.includes(fragment)) throw new Error(`Migration invariant is missing: ${fragment}`);
}

console.log(`Validated ${names.length} ordered Supabase migrations (${versions[0]}..${versions.at(-1)}).`);
