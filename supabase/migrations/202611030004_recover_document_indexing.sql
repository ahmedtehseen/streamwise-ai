alter table public.project_documents
add column failure_retryable boolean not null default false;

create or replace function public.fail_project_document_indexing(
  p_document_id uuid,
  p_failure_detail text,
  p_failure_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  failed_document public.project_documents;
begin
  delete from public.document_chunks where project_document_id = p_document_id;

  update public.project_documents
  set status = 'failed',
      failure_detail = p_failure_detail,
      failure_retryable = p_failure_retryable,
      updated_at = now()
  where id = p_document_id and status = 'indexing'
  returning * into failed_document;

  if failed_document.id is null then
    raise exception 'Project Document is not indexing';
  end if;
  return to_jsonb(failed_document);
end;
$$;

revoke all on function public.fail_project_document_indexing(uuid, text, boolean) from public;
grant execute on function public.fail_project_document_indexing(uuid, text, boolean) to service_role;

create or replace function public.retry_project_document_indexing(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  indexing_document public.project_documents;
begin
  delete from public.document_chunks
  where project_document_id = p_document_id
    and exists (
      select 1 from public.project_documents
      where id = p_document_id and status = 'failed' and failure_retryable = true
    );

  update public.project_documents
  set status = 'indexing',
      failure_detail = null,
      failure_retryable = false,
      updated_at = now()
  where id = p_document_id and status = 'failed' and failure_retryable = true
  returning * into indexing_document;

  if indexing_document.id is null then
    raise exception 'Project Document is not safely retryable';
  end if;
  return to_jsonb(indexing_document);
end;
$$;

revoke all on function public.retry_project_document_indexing(uuid) from public;
grant execute on function public.retry_project_document_indexing(uuid) to service_role;
