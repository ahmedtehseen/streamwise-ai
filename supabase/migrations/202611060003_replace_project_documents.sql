alter table public.project_documents
  add column replaces_document_id uuid references public.project_documents(id) on delete cascade;

create unique index project_documents_one_pending_replacement
  on public.project_documents (replaces_document_id)
  where replaces_document_id is not null;

create or replace function public.begin_project_document_indexing(p_document jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  admitted_document public.project_documents;
  requested_knowledge_base_id uuid := (p_document->>'knowledge_base_id')::uuid;
begin
  perform id from public.knowledge_bases where id = requested_knowledge_base_id for update;
  if not found then raise exception 'Knowledge Base does not exist'; end if;

  if (select count(*) from public.project_documents where knowledge_base_id = requested_knowledge_base_id and replaces_document_id is null) >= 20 then
    raise exception 'KNOWLEDGE_BASE_CAPACITY';
  end if;

  insert into public.project_documents (
    knowledge_base_id, name, media_type, byte_size, original_text, content_fingerprint, status
  ) values (
    requested_knowledge_base_id, p_document->>'name', p_document->>'media_type',
    (p_document->>'byte_size')::integer, p_document->>'original_text',
    p_document->>'content_fingerprint', 'indexing'
  ) returning * into admitted_document;
  return to_jsonb(admitted_document);
end;
$$;

create or replace function public.begin_project_document_replacement(p_document_id uuid, p_document jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_document public.project_documents;
  admitted_document public.project_documents;
begin
  select * into current_document
  from public.project_documents
  where id = p_document_id and status = 'ready' and replaces_document_id is null
  for update;

  if current_document.id is null then raise exception 'PROJECT_DOCUMENT_NOT_REPLACEABLE'; end if;
  if exists (select 1 from public.project_documents where replaces_document_id = p_document_id) then
    raise exception 'DOCUMENT_REPLACEMENT_PENDING';
  end if;

  insert into public.project_documents (
    knowledge_base_id, name, media_type, byte_size, original_text,
    content_fingerprint, status, replaces_document_id
  ) values (
    current_document.knowledge_base_id, p_document->>'name', p_document->>'media_type',
    (p_document->>'byte_size')::integer, p_document->>'original_text',
    p_document->>'content_fingerprint', 'indexing', current_document.id
  ) returning * into admitted_document;
  return to_jsonb(admitted_document);
end;
$$;

create or replace function public.complete_project_document_indexing(p_document_id uuid, p_chunks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  chunk jsonb;
  completed_document public.project_documents;
  superseded_document_id uuid;
begin
  if jsonb_array_length(p_chunks) = 0 then raise exception 'At least one chunk is required'; end if;

  select replaces_document_id into superseded_document_id
  from public.project_documents
  where id = p_document_id and status = 'indexing'
  for update;
  if not found then raise exception 'Project Document is not indexing'; end if;

  delete from public.document_chunks where project_document_id = p_document_id;
  for chunk in select value from jsonb_array_elements(p_chunks)
  loop
    insert into public.document_chunks (
      project_document_id, ordinal, text, heading_path, start_line, end_line,
      embedding_model, embedding_dimension, embedding
    ) values (
      p_document_id, (chunk->>'ordinal')::integer, chunk->>'text',
      array(select jsonb_array_elements_text(chunk->'heading_path')),
      (chunk->>'start_line')::integer, (chunk->>'end_line')::integer,
      chunk->>'embedding_model', (chunk->>'embedding_dimension')::integer,
      (chunk->'embedding')::text::extensions.vector
    );
  end loop;

  update public.project_documents
  set status = 'ready', failure_detail = null, failure_retryable = false,
      replaces_document_id = null, updated_at = now()
  where id = p_document_id and status = 'indexing'
  returning * into completed_document;

  if superseded_document_id is not null then
    delete from public.project_documents where id = superseded_document_id;
  end if;
  return to_jsonb(completed_document);
end;
$$;

create or replace function public.retry_project_document_replacement(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  indexing_document public.project_documents;
begin
  update public.project_documents
  set status = 'indexing', failure_detail = null, failure_retryable = false, updated_at = now()
  where replaces_document_id = p_document_id and status = 'failed' and failure_retryable = true
  returning * into indexing_document;
  if indexing_document.id is null then raise exception 'Document Replacement is not safely retryable'; end if;
  return to_jsonb(indexing_document);
end;
$$;

create or replace function public.discard_project_document_replacement(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  discarded_document public.project_documents;
begin
  delete from public.project_documents
  where replaces_document_id = p_document_id and status = 'failed'
  returning * into discarded_document;
  if discarded_document.id is null then raise exception 'Document Replacement is not discardable'; end if;
  return to_jsonb(discarded_document);
end;
$$;

revoke all on function public.begin_project_document_replacement(uuid, jsonb) from public;
grant execute on function public.begin_project_document_replacement(uuid, jsonb) to service_role;
revoke all on function public.retry_project_document_replacement(uuid) from public;
grant execute on function public.retry_project_document_replacement(uuid) to service_role;
revoke all on function public.discard_project_document_replacement(uuid) from public;
grant execute on function public.discard_project_document_replacement(uuid) to service_role;
