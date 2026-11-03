create extension if not exists vector with schema extensions;

create table public.knowledge_bases (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.knowledge_bases (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Shared private Knowledge Base');

create type public.project_document_status as enum ('indexing', 'ready', 'failed');

create table public.project_documents (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_bases(id) on delete cascade,
  name text not null,
  media_type text not null check (media_type in ('text/markdown', 'text/plain')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 512000),
  original_text text not null,
  content_fingerprint text not null,
  status public.project_document_status not null default 'indexing',
  failure_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (knowledge_base_id, content_fingerprint)
);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  project_document_id uuid not null references public.project_documents(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  text text not null,
  heading_path text[] not null default '{}',
  start_line integer not null check (start_line > 0),
  end_line integer not null check (end_line >= start_line),
  embedding_model text not null check (embedding_model = 'gemini-embedding-2'),
  embedding_dimension integer not null check (embedding_dimension = 768),
  embedding extensions.vector(768) not null,
  created_at timestamptz not null default now(),
  unique (project_document_id, ordinal)
);

alter table public.knowledge_bases enable row level security;
alter table public.project_documents enable row level security;
alter table public.document_chunks enable row level security;

create or replace function public.complete_project_document_indexing(p_document_id uuid, p_chunks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  chunk jsonb;
  completed_document public.project_documents;
begin
  if jsonb_array_length(p_chunks) = 0 then
    raise exception 'At least one chunk is required';
  end if;

  delete from public.document_chunks where project_document_id = p_document_id;
  for chunk in select value from jsonb_array_elements(p_chunks)
  loop
    insert into public.document_chunks (
      project_document_id, ordinal, text, heading_path, start_line, end_line,
      embedding_model, embedding_dimension, embedding
    ) values (
      p_document_id,
      (chunk->>'ordinal')::integer,
      chunk->>'text',
      array(select jsonb_array_elements_text(chunk->'heading_path')),
      (chunk->>'start_line')::integer,
      (chunk->>'end_line')::integer,
      chunk->>'embedding_model',
      (chunk->>'embedding_dimension')::integer,
      (chunk->'embedding')::text::extensions.vector
    );
  end loop;

  update public.project_documents
  set status = 'ready', failure_detail = null, updated_at = now()
  where id = p_document_id and status = 'indexing'
  returning * into completed_document;

  if completed_document.id is null then
    raise exception 'Project Document is not indexing';
  end if;
  return to_jsonb(completed_document);
end;
$$;

revoke all on function public.complete_project_document_indexing(uuid, jsonb) from public;
grant execute on function public.complete_project_document_indexing(uuid, jsonb) to service_role;
