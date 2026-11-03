alter table public.project_documents
  add constraint project_documents_original_text_not_empty
  check (btrim(original_text) <> ''),
  add constraint project_documents_fingerprint_format
  check (content_fingerprint ~ '^[0-9a-f]{64}$');

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
  perform id
  from public.knowledge_bases
  where id = requested_knowledge_base_id
  for update;

  if not found then
    raise exception 'Knowledge Base does not exist';
  end if;

  if (select count(*) from public.project_documents where knowledge_base_id = requested_knowledge_base_id) >= 20 then
    raise exception 'KNOWLEDGE_BASE_CAPACITY';
  end if;

  insert into public.project_documents (
    knowledge_base_id, name, media_type, byte_size, original_text, content_fingerprint, status
  ) values (
    requested_knowledge_base_id,
    p_document->>'name',
    p_document->>'media_type',
    (p_document->>'byte_size')::integer,
    p_document->>'original_text',
    p_document->>'content_fingerprint',
    'indexing'
  )
  returning * into admitted_document;

  return to_jsonb(admitted_document);
end;
$$;

revoke all on function public.begin_project_document_indexing(jsonb) from public;
grant execute on function public.begin_project_document_indexing(jsonb) to service_role;
